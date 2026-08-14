import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";

const FINAL_PAYMENT_STATUSES = new Set(["refunded", "chargeback"]);

function nextPaymentStatus(current, incoming) {
  if (FINAL_PAYMENT_STATUSES.has(current)) return current;
  if (incoming === "paid" || FINAL_PAYMENT_STATUSES.has(incoming)) return incoming;
  return current === "paid" ? current : incoming;
}

// This store is intentionally independent from the Academy/LMS schema.  It
// owns physical-product data only; no runtime query may target courses,
// settings, users, enrollments or any remote catalogue service.
export function createGalaticMySqlStore(databaseUrl) {
  const url = new URL(databaseUrl);
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    timezone: "Z",
    dateStrings: true,
  });
  let ready;

  async function ensureSchema() {
    if (ready) return ready;
    ready = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS galatic_products (
          sku VARCHAR(80) PRIMARY KEY, slug VARCHAR(100) NOT NULL UNIQUE,
          title VARCHAR(255) NOT NULL, description MEDIUMTEXT NULL,
          image_url VARCHAR(1000) NULL, category_name VARCHAR(120) NULL,
          brand VARCHAR(120) NULL, unit_amount_cents INT UNSIGNED NOT NULL,
          currency CHAR(3) NOT NULL DEFAULT 'BRL', active TINYINT(1) NOT NULL DEFAULT 1,
          manage_stock TINYINT(1) NOT NULL DEFAULT 1, stock_quantity INT NULL,
          weight_grams INT UNSIGNED NULL, length_cm DECIMAL(8,2) NULL,
          width_cm DECIMAL(8,2) NULL, height_cm DECIMAL(8,2) NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          INDEX galatic_products_saleable (active, manage_stock, stock_quantity)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_shipping_quotes (
          id CHAR(36) PRIMARY KEY, destination_postcode CHAR(8) NOT NULL,
          service_code VARCHAR(80) NOT NULL, service_name VARCHAR(160) NOT NULL,
          amount_cents INT UNSIGNED NOT NULL, delivery_days SMALLINT UNSIGNED NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'quoted', expires_at DATETIME(3) NOT NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_shipping_quotes_expiry (expires_at)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_shipping_quote_items (
          quote_id CHAR(36) NOT NULL, sku VARCHAR(80) NOT NULL, quantity SMALLINT UNSIGNED NOT NULL,
          PRIMARY KEY (quote_id, sku),
          CONSTRAINT galatic_quote_items_quote_fk FOREIGN KEY (quote_id) REFERENCES galatic_shipping_quotes(id) ON DELETE CASCADE,
          CONSTRAINT galatic_quote_items_product_fk FOREIGN KEY (sku) REFERENCES galatic_products(sku)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_orders (
          id CHAR(36) PRIMARY KEY, payment_provider VARCHAR(24) NULL,
          payment_provider_order_id VARCHAR(80) NULL UNIQUE, payment_status VARCHAR(32) NOT NULL DEFAULT 'pending',
          buyer_email VARCHAR(160) NOT NULL, buyer_name VARCHAR(180) NOT NULL,
          buyer_document VARCHAR(14) NULL, buyer_phone VARCHAR(13) NULL, shipping_address_json JSON NOT NULL,
          shipping_quote_id CHAR(36) NULL, subtotal_cents INT UNSIGNED NOT NULL,
          shipping_cents INT UNSIGNED NOT NULL DEFAULT 0, total_cents INT UNSIGNED NOT NULL,
          fulfillment_status VARCHAR(32) NOT NULL DEFAULT 'awaiting_payment',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          INDEX galatic_orders_status_time (payment_status, updated_at),
          CONSTRAINT galatic_orders_quote_fk FOREIGN KEY (shipping_quote_id) REFERENCES galatic_shipping_quotes(id)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_order_items (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL,
          sku VARCHAR(80) NOT NULL, title VARCHAR(255) NOT NULL, quantity SMALLINT UNSIGNED NOT NULL,
          unit_amount_cents INT UNSIGNED NOT NULL, total_amount_cents INT UNSIGNED NOT NULL,
          CONSTRAINT galatic_order_items_order_fk FOREIGN KEY (order_id) REFERENCES galatic_orders(id) ON DELETE CASCADE,
          CONSTRAINT galatic_order_items_product_fk FOREIGN KEY (sku) REFERENCES galatic_products(sku)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_payment_events (
          event_id VARCHAR(128) PRIMARY KEY, provider VARCHAR(24) NOT NULL,
          provider_order_id VARCHAR(80) NOT NULL, status VARCHAR(32) NOT NULL,
          received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_payment_events_order (provider, provider_order_id, received_at)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_checkout_attempts (
          idempotency_key CHAR(36) PRIMARY KEY, request_fingerprint CHAR(64) NOT NULL,
          order_id CHAR(36) NULL, state VARCHAR(24) NOT NULL DEFAULT 'pending',
          response_status SMALLINT UNSIGNED NULL, response_json JSON NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          INDEX galatic_checkout_attempts_order (order_id)
        )`,
      ];
      for (const statement of statements) await pool.query(statement);

      // A loja Galatic já possuía um catálogo operacional na tabela `products`
      // antes da consolidação do gateway. Na primeira inicialização, copie esse
      // catálogo para o namespace exclusivo do serviço de pagamentos sem
      // alterar nem apagar os dados originais da loja.
      const [[legacyProducts]] = await pool.query(
        "SELECT 1 present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products'",
      );
      if (legacyProducts) {
        const [legacyColumns] = await pool.query(
          "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products'",
        );
        const columns = new Set(legacyColumns.map((row) => row.COLUMN_NAME));
        const value = (column, fallback) => columns.has(column) ? `\`${column}\`` : fallback;
        if (columns.has("sku") && columns.has("name") && columns.has("unit_amount")) {
          const availableStock = columns.has("reserved_quantity")
            ? `GREATEST(${value("stock_quantity", "0")}-COALESCE(\`reserved_quantity\`,0),0)`
            : value("stock_quantity", "NULL");
          await pool.query(
            `INSERT INTO galatic_products
             (sku,slug,title,description,image_url,category_name,brand,unit_amount_cents,currency,active,
              manage_stock,stock_quantity,weight_grams,length_cm,width_cm,height_cm)
             SELECT UPPER(TRIM(\`sku\`)),
                    ${value("slug", "LOWER(REPLACE(TRIM(`sku`),'_','-'))")},
                    TRIM(\`name\`),${value("description", "''")},${value("image_url", "NULL")},
                    ${value("category", "NULL")},${value("brand", "NULL")},\`unit_amount\`,
                    UPPER(${value("currency", "'BRL'")}),${value("active", "1")},
                    ${value("manage_stock", "1")},${availableStock},${value("weight_grams", "NULL")},
                    ${value("length_cm", "NULL")},${value("width_cm", "NULL")},${value("height_cm", "NULL")}
             FROM products WHERE TRIM(\`sku\`)<>'' AND TRIM(\`name\`)<>'' AND \`unit_amount\`>=0
             ON DUPLICATE KEY UPDATE slug=VALUES(slug),title=VALUES(title),description=VALUES(description),
               image_url=VALUES(image_url),category_name=VALUES(category_name),brand=VALUES(brand),
               unit_amount_cents=VALUES(unit_amount_cents),currency=VALUES(currency),active=VALUES(active),
               manage_stock=VALUES(manage_stock),stock_quantity=VALUES(stock_quantity),
               weight_grams=VALUES(weight_grams),length_cm=VALUES(length_cm),width_cm=VALUES(width_cm),height_cm=VALUES(height_cm)`,
          );
        }
      }
      const [[catalog]] = await pool.query("SELECT COUNT(*) total FROM galatic_products WHERE active=1");
      if (Number(catalog?.total ?? 0) < 1) throw new Error("O catálogo de pagamento da Galatic está vazio.");
    })();
    return ready;
  }

  return {
    ensureSchema,
    async createShippingQuotes({ destinationPostcode, items, quotes }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const ids = [];
        for (const quote of quotes) {
          const id = randomUUID();
          ids.push(id);
          await connection.query(
            `INSERT INTO galatic_shipping_quotes
             (id,destination_postcode,service_code,service_name,amount_cents,delivery_days,expires_at)
             VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE))`,
            [id, destinationPostcode, quote.serviceCode, quote.serviceName, quote.amountCents, quote.deliveryDays],
          );
          for (const item of items) {
            await connection.query(
              "INSERT INTO galatic_shipping_quote_items (quote_id,sku,quantity) VALUES (?,?,?)",
              [id, item.sku, item.quantity],
            );
          }
        }
        await connection.commit();
        return quotes.map((quote, index) => ({ ...quote, id: ids[index], expiresIn: 900 }));
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    },
    async getProductsForCheckout(items) {
      await ensureSchema();
      const keys = [...new Set(items.map((item) => item.key))];
      if (!keys.length) return [];
      const placeholders = keys.map(() => "?").join(",");
      const [rows] = await pool.query(
        `SELECT sku,slug,title,unit_amount_cents,active,manage_stock,stock_quantity,
                weight_grams,length_cm,width_cm,height_cm
         FROM galatic_products WHERE sku IN (${placeholders}) OR slug IN (${placeholders})`,
        [...keys, ...keys],
      );
      return rows.map((row) => ({
        sku: row.sku, slug: row.slug, title: row.title,
        unitAmountCents: Number(row.unit_amount_cents), active: Boolean(row.active),
        manageStock: Boolean(row.manage_stock), stockQuantity: row.stock_quantity === null ? null : Number(row.stock_quantity),
        weightGrams: row.weight_grams === null ? null : Number(row.weight_grams),
        lengthCm: row.length_cm === null ? null : Number(row.length_cm), widthCm: row.width_cm === null ? null : Number(row.width_cm),
        heightCm: row.height_cm === null ? null : Number(row.height_cm),
      }));
    },
    async prepareOrder({ key, fingerprint, items, quoteId, buyer }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[attempt]] = await connection.query(
          "SELECT request_fingerprint,state,response_status,response_json FROM galatic_checkout_attempts WHERE idempotency_key=? FOR UPDATE",
          [key],
        );
        if (attempt) {
          await connection.rollback();
          if (attempt.request_fingerprint !== fingerprint) return { kind: "conflict" };
          if (attempt.state === "completed") return {
            kind: "replay", response: { status: Number(attempt.response_status), body: typeof attempt.response_json === "string" ? JSON.parse(attempt.response_json) : attempt.response_json },
          };
          return { kind: "pending" };
        }
        await connection.query(
          "INSERT INTO galatic_checkout_attempts (idempotency_key,request_fingerprint) VALUES (?,?)",
          [key, fingerprint],
        );
        const keys = [...new Set(items.map((item) => item.key))];
        const placeholders = keys.map(() => "?").join(",");
        const [products] = await connection.query(
          `SELECT sku,slug,title,unit_amount_cents,active,manage_stock,stock_quantity
           FROM galatic_products WHERE sku IN (${placeholders}) OR slug IN (${placeholders}) FOR UPDATE`,
          [...keys, ...keys],
        );
        const byKey = new Map();
        for (const product of products) { byKey.set(product.sku, product); byKey.set(product.slug, product); }
        const lines = items.map((item) => ({ product: byKey.get(item.key), quantity: item.quantity }));
        if (lines.some((line) => !line.product || !line.product.active)) throw Object.assign(new Error("product_unavailable"), { code: "product_unavailable" });
        for (const line of lines) {
          if (line.product.manage_stock && (!Number.isInteger(line.product.stock_quantity) || line.product.stock_quantity < line.quantity)) {
            throw Object.assign(new Error("insufficient_stock"), { code: "insufficient_stock" });
          }
        }
        const [[quote]] = await connection.query(
          `SELECT id,amount_cents,service_name,destination_postcode FROM galatic_shipping_quotes
           WHERE id=? AND status='quoted' AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE`, [quoteId],
        );
        if (!quote) throw Object.assign(new Error("invalid_shipping_quote"), { code: "invalid_shipping_quote" });
        const [quotedItems] = await connection.query(
          "SELECT sku,quantity FROM galatic_shipping_quote_items WHERE quote_id=?", [quoteId],
        );
        const expected = [...lines].map((line) => `${line.product.sku}:${line.quantity}`).sort().join("|");
        const quoted = quotedItems.map((item) => `${item.sku}:${Number(item.quantity)}`).sort().join("|");
        if (expected !== quoted) throw Object.assign(new Error("shipping_quote_mismatch"), { code: "shipping_quote_mismatch" });
        const orderId = randomUUID();
        const subtotalCents = lines.reduce((sum, line) => sum + Number(line.product.unit_amount_cents) * line.quantity, 0);
        const shippingCents = Number(quote.amount_cents);
        await connection.query(
          `INSERT INTO galatic_orders
           (id,payment_provider,payment_status,buyer_email,buyer_name,buyer_document,buyer_phone,shipping_address_json,
            shipping_quote_id,subtotal_cents,shipping_cents,total_cents)
           VALUES (?,'asaas','pending',?,?,?,?,?,?,?,?,?)`,
          [orderId, buyer.email, buyer.name, buyer.document, buyer.phone, JSON.stringify(buyer.address), quoteId, subtotalCents, shippingCents, subtotalCents + shippingCents],
        );
        for (const line of lines) {
          const lineTotal = Number(line.product.unit_amount_cents) * line.quantity;
          await connection.query(
            `INSERT INTO galatic_order_items (order_id,sku,title,quantity,unit_amount_cents,total_amount_cents)
             VALUES (?,?,?,?,?,?)`,
            [orderId, line.product.sku, line.product.title, line.quantity, line.product.unit_amount_cents, lineTotal],
          );
          if (line.product.manage_stock) await connection.query(
            "UPDATE galatic_products SET stock_quantity=stock_quantity-? WHERE sku=?", [line.quantity, line.product.sku],
          );
        }
        await connection.query("UPDATE galatic_shipping_quotes SET status='consumed' WHERE id=?", [quoteId]);
        await connection.query("UPDATE galatic_checkout_attempts SET order_id=? WHERE idempotency_key=?", [orderId, key]);
        await connection.commit();
        return { kind: "created", order: { id: orderId, subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents, serviceName: quote.service_name, lines: lines.map((line) => ({ sku: line.product.sku, title: line.product.title, quantity: line.quantity, unitAmountCents: Number(line.product.unit_amount_cents) })) } };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    },
    async attachPayment(orderId, providerOrderId, status) {
      await ensureSchema();
      await pool.query(
        "UPDATE galatic_orders SET payment_provider_order_id=?,payment_status=? WHERE id=?",
        [providerOrderId, status, orderId],
      );
    },
    async completeCheckoutAttempt(key, response) {
      await ensureSchema();
      await pool.query(
        "UPDATE galatic_checkout_attempts SET state='completed',response_status=?,response_json=? WHERE idempotency_key=?",
        [response.status, JSON.stringify(response.body), key],
      );
    },
    async releaseFailedOrder(orderId, key) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [lines] = await connection.query("SELECT sku,quantity FROM galatic_order_items WHERE order_id=? FOR UPDATE", [orderId]);
        for (const line of lines) await connection.query(
          "UPDATE galatic_products SET stock_quantity=stock_quantity+? WHERE sku=? AND manage_stock=1", [line.quantity, line.sku],
        );
        await connection.query("UPDATE galatic_orders SET payment_status='failed',fulfillment_status='payment_failed' WHERE id=?", [orderId]);
        await connection.query("DELETE FROM galatic_checkout_attempts WHERE idempotency_key=?", [key]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async getOrderByPublicId(orderId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        "SELECT id,payment_provider_order_id,payment_status,subtotal_cents,shipping_cents,total_cents,fulfillment_status FROM galatic_orders WHERE id=?", [orderId],
      );
      return row ? { id: row.id, providerOrderId: row.payment_provider_order_id, status: row.payment_status, subtotalCents: Number(row.subtotal_cents), shippingCents: Number(row.shipping_cents), totalCents: Number(row.total_cents), fulfillmentStatus: row.fulfillment_status } : null;
    },
    async getOrderByProviderOrderId(provider, providerOrderId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        "SELECT id,payment_provider_order_id,payment_status,subtotal_cents,shipping_cents,total_cents,fulfillment_status FROM galatic_orders WHERE payment_provider=? AND payment_provider_order_id=?", [provider, providerOrderId],
      );
      return row ? { id: row.id, providerOrderId: row.payment_provider_order_id, status: row.payment_status, subtotalCents: Number(row.subtotal_cents), shippingCents: Number(row.shipping_cents), totalCents: Number(row.total_cents), fulfillmentStatus: row.fulfillment_status } : null;
    },
    async updateOrderFromWebhook({ provider, providerOrderId, status, eventId }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (eventId) {
          const [seen] = await connection.query(
            "SELECT event_id FROM galatic_payment_events WHERE event_id=?",
            [eventId],
          );
          if (seen.length) {
            await connection.rollback();
            return { duplicate: true };
          }
        }
        const [[order]] = await connection.query(
          `SELECT id,payment_status FROM galatic_orders
           WHERE payment_provider=? AND payment_provider_order_id=? FOR UPDATE`,
          [provider, providerOrderId],
        );
        const previousStatus = order?.payment_status ?? null;
        const resolvedStatus = order ? nextPaymentStatus(previousStatus, status) : status;
        if (eventId) {
          await connection.query(
            `INSERT INTO galatic_payment_events
             (event_id,provider,provider_order_id,status) VALUES (?,?,?,?)`,
            [eventId, provider, providerOrderId, resolvedStatus],
          );
        }
        if (order) {
          await connection.query(
            `UPDATE galatic_orders SET payment_status=?,
             fulfillment_status=CASE
               WHEN ?='paid' AND fulfillment_status='awaiting_payment' THEN 'paid'
               WHEN ? IN ('refunded','chargeback') THEN 'payment_reversed'
               ELSE fulfillment_status END
             WHERE id=?`,
            [resolvedStatus, resolvedStatus, resolvedStatus, order.id],
          );
        }
        await connection.commit();
        return {
          id: order?.id ?? null,
          status: resolvedStatus,
          previousStatus,
          deferred: !order,
        };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() { await pool.end(); },
  };
}
