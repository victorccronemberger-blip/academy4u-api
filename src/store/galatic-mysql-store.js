import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { hardenedPoolOptions } from "./pool-options.js";

const FINAL_PAYMENT_STATUSES = new Set(["refunded", "chargeback"]);

function nextPaymentStatus(current, incoming) {
  if (FINAL_PAYMENT_STATUSES.has(current)) return current;
  if (incoming === "paid" || FINAL_PAYMENT_STATUSES.has(incoming)) return incoming;
  return current === "paid" ? current : incoming;
}

function customerView(row) {
  if (!row) return null;
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    phone: row.phone ?? "",
    email_verified: Boolean(row.email_verified_at),
    marketing_consent: Boolean(row.marketing_consent),
    created_at: row.created_at,
  };
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
    ...hardenedPoolOptions(),
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
        `CREATE TABLE IF NOT EXISTS galatic_operational_alerts (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, alert_type VARCHAR(48) NOT NULL,
          severity VARCHAR(16) NOT NULL DEFAULT 'error', source VARCHAR(48) NOT NULL,
          summary VARCHAR(255) NOT NULL, context_json JSON NULL,
          occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_alerts_type_time (alert_type, occurred_at)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_customers (
          id CHAR(36) PRIMARY KEY, first_name VARCHAR(90) NOT NULL,
          last_name VARCHAR(90) NOT NULL, email VARCHAR(160) NOT NULL UNIQUE,
          phone VARCHAR(20) NULL, password_hash VARCHAR(255) NOT NULL,
          email_verified_at DATETIME(3) NULL, marketing_consent TINYINT(1) NOT NULL DEFAULT 0,
          newsletter_enabled TINYINT(1) NOT NULL DEFAULT 0,
          newsletter_status VARCHAR(24) NOT NULL DEFAULT 'disabled',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          INDEX galatic_customers_created (created_at)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_customer_sessions (
          id CHAR(36) PRIMARY KEY, customer_id CHAR(36) NOT NULL,
          token_hash CHAR(64) NOT NULL UNIQUE, expires_at DATETIME(3) NOT NULL,
          last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          revoked_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_sessions_customer (customer_id, revoked_at, expires_at),
          CONSTRAINT galatic_sessions_customer_fk FOREIGN KEY (customer_id) REFERENCES galatic_customers(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_customer_tokens (
          token_hash CHAR(64) PRIMARY KEY, customer_id CHAR(36) NOT NULL,
          purpose VARCHAR(24) NOT NULL, expires_at DATETIME(3) NOT NULL,
          consumed_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_customer_tokens_lookup (customer_id, purpose, expires_at),
          CONSTRAINT galatic_tokens_customer_fk FOREIGN KEY (customer_id) REFERENCES galatic_customers(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_customer_addresses (
          id CHAR(36) PRIMARY KEY, customer_id CHAR(36) NOT NULL,
          label VARCHAR(80) NOT NULL, recipient_name VARCHAR(180) NOT NULL,
          federal_tax_id VARCHAR(14) NULL, postal_code CHAR(8) NOT NULL,
          street VARCHAR(180) NOT NULL, number VARCHAR(30) NOT NULL,
          complement VARCHAR(120) NULL, district VARCHAR(120) NOT NULL,
          city VARCHAR(120) NOT NULL, state CHAR(2) NOT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          INDEX galatic_addresses_customer (customer_id, is_default),
          CONSTRAINT galatic_addresses_customer_fk FOREIGN KEY (customer_id) REFERENCES galatic_customers(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_newsletter_subscribers (
          email VARCHAR(160) PRIMARY KEY, status VARCHAR(24) NOT NULL DEFAULT 'active',
          customer_id CHAR(36) NULL, consent_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_contact_messages (
          id CHAR(36) PRIMARY KEY, customer_id CHAR(36) NULL, name VARCHAR(180) NOT NULL,
          email VARCHAR(160) NOT NULL, subject VARCHAR(180) NOT NULL, message TEXT NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'open', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_contact_status_time (status, created_at)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_notification_log (
          notification_key VARCHAR(160) PRIMARY KEY, status VARCHAR(24) NOT NULL DEFAULT 'claimed',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
        )`,
      ];
      for (const statement of statements) await pool.query(statement);
      for (const alteration of [
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS customer_id CHAR(36) NULL AFTER id",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(24) NOT NULL DEFAULT 'pix' AFTER payment_status",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS payment_provider_group_id VARCHAR(80) NULL AFTER payment_provider_order_id",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS installments TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER payment_method",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS installment_amount_cents INT UNSIGNED NULL AFTER installments",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS payment_fee_cents INT UNSIGNED NOT NULL DEFAULT 0 AFTER installment_amount_cents",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS discount_cents INT UNSIGNED NOT NULL DEFAULT 0 AFTER shipping_cents",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS paid_at DATETIME(3) NULL AFTER fulfillment_status",
      ]) await pool.query(alteration);

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

  async function recordOperationalAlert(value) {
    await ensureSchema();
    await pool.query(
      "INSERT INTO galatic_operational_alerts (alert_type,severity,source,summary,context_json) VALUES (?,?,?,?,?)",
      [value.type, value.severity ?? "error", value.source ?? "galatic-api", String(value.summary).slice(0, 255), JSON.stringify(value.context ?? {})],
    );
  }

  return {
    ensureSchema,
    recordOperationalAlert,
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
    async prepareOrder({ key, fingerprint, items, quoteId, buyer, paymentMethod = "pix", installments = 1 }) {
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
        const [[matchedCustomer]] = await connection.query("SELECT id FROM galatic_customers WHERE email=?", [buyer.email]);
        await connection.query(
          `INSERT INTO galatic_orders
           (id,customer_id,payment_provider,payment_status,payment_method,installments,buyer_email,buyer_name,buyer_document,buyer_phone,shipping_address_json,
            shipping_quote_id,subtotal_cents,shipping_cents,total_cents)
           VALUES (?,?,'asaas','pending',?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId, matchedCustomer?.id ?? null, paymentMethod, installments, buyer.email, buyer.name, buyer.document, buyer.phone, JSON.stringify(buyer.address), quoteId, subtotalCents, shippingCents, subtotalCents + shippingCents],
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
    async attachPayment(orderId, providerOrderId, status, details = {}) {
      await ensureSchema();
      await pool.query(
        `UPDATE galatic_orders SET payment_provider_order_id=?,payment_status=?,payment_method=?,installments=?,
         installment_amount_cents=?,payment_fee_cents=?,payment_provider_group_id=?,total_cents=COALESCE(?,total_cents),
         paid_at=CASE WHEN ?='paid' THEN UTC_TIMESTAMP(3) ELSE paid_at END WHERE id=?`,
        [providerOrderId, status, details.method ?? "pix", details.installments ?? 1,
          details.installmentAmountCents ?? null, details.paymentFeeCents ?? 0, details.providerGroupId ?? null, details.totalCents ?? null, status, orderId],
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
        "SELECT id,payment_provider_order_id,payment_status,payment_method,installments,installment_amount_cents,subtotal_cents,shipping_cents,total_cents,fulfillment_status FROM galatic_orders WHERE id=?", [orderId],
      );
      return row ? { id: row.id, providerOrderId: row.payment_provider_order_id, status: row.payment_status, method: row.payment_method, installments: Number(row.installments), installmentAmountCents: row.installment_amount_cents === null ? null : Number(row.installment_amount_cents), subtotalCents: Number(row.subtotal_cents), shippingCents: Number(row.shipping_cents), totalCents: Number(row.total_cents), fulfillmentStatus: row.fulfillment_status } : null;
    },
    async getOrderByProviderOrderId(provider, providerOrderId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        "SELECT id,payment_provider_order_id,payment_status,subtotal_cents,shipping_cents,total_cents,fulfillment_status FROM galatic_orders WHERE payment_provider=? AND payment_provider_order_id=?", [provider, providerOrderId],
      );
      return row ? { id: row.id, providerOrderId: row.payment_provider_order_id, status: row.payment_status, subtotalCents: Number(row.subtotal_cents), shippingCents: Number(row.shipping_cents), totalCents: Number(row.total_cents), fulfillmentStatus: row.fulfillment_status } : null;
    },
    async getOrderNotification(orderId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        "SELECT id,buyer_email email,buyer_name name,total_cents,payment_method FROM galatic_orders WHERE id=?", [orderId],
      );
      return row ? { orderId: row.id, email: row.email, name: row.name, totalCents: Number(row.total_cents), method: row.payment_method } : null;
    },
    async claimNotification(key) {
      await ensureSchema();
      const [result] = await pool.query("INSERT IGNORE INTO galatic_notification_log (notification_key) VALUES (?)", [String(key).slice(0, 160)]);
      return result.affectedRows === 1;
    },
    async releaseNotification(key) {
      await ensureSchema();
      await pool.query("DELETE FROM galatic_notification_log WHERE notification_key=? AND status='claimed'", [String(key).slice(0, 160)]);
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
            `UPDATE galatic_orders SET payment_status=?,paid_at=CASE WHEN ?='paid' THEN COALESCE(paid_at,UTC_TIMESTAMP(3)) ELSE paid_at END,
             fulfillment_status=CASE
               WHEN ?='paid' AND fulfillment_status='awaiting_payment' THEN 'paid'
               WHEN ? IN ('refunded','chargeback') THEN 'payment_reversed'
               ELSE fulfillment_status END
             WHERE id=?`,
            [resolvedStatus, resolvedStatus, resolvedStatus, resolvedStatus, order.id],
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
    async updatePaymentInstallmentFromWebhook({ provider, providerOrderId, providerGroupId, installment, eventId }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (eventId) {
          const [result] = await connection.query(
            "INSERT IGNORE INTO galatic_payment_events (event_id,provider,provider_order_id,status) VALUES (?,?,?,?)",
            [eventId, provider, providerOrderId, installment?.status ?? "unknown"],
          );
          if (result.affectedRows === 0) { await connection.rollback(); return { duplicate: true }; }
        }
        const [[order]] = await connection.query(
          `SELECT id,payment_status FROM galatic_orders
           WHERE payment_provider=? AND (payment_provider_group_id=? OR payment_provider_order_id=?) FOR UPDATE`,
          [provider, providerGroupId, providerOrderId],
        );
        if (!order) {
          await connection.commit();
          return { duplicate: false, deferred: true };
        }
        const status = nextPaymentStatus(order.payment_status, installment?.status ?? "open");
        await connection.query(
          `UPDATE galatic_orders SET payment_status=?,paid_at=CASE WHEN ?='paid' THEN COALESCE(paid_at,UTC_TIMESTAMP(3)) ELSE paid_at END,
           fulfillment_status=CASE WHEN ?='paid' AND fulfillment_status='awaiting_payment' THEN 'paid'
           WHEN ? IN ('refunded','chargeback') THEN 'payment_reversed' ELSE fulfillment_status END WHERE id=?`,
          [status, status, status, status, order.id],
        );
        await connection.commit();
        return { duplicate: false, id: order.id, status, previousStatus: order.payment_status };
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    async createCustomer({ firstName, lastName, email, phone, passwordHash, marketingConsent }) {
      await ensureSchema();
      const id = randomUUID();
      try {
        await pool.query(
          `INSERT INTO galatic_customers
           (id,first_name,last_name,email,phone,password_hash,marketing_consent,newsletter_enabled,newsletter_status)
           VALUES (?,?,?,?,?,?,?,? ,?)`,
          [id, firstName, lastName, email, phone || null, passwordHash, marketingConsent ? 1 : 0,
            marketingConsent ? 1 : 0, marketingConsent ? "active" : "disabled"],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") throw Object.assign(new Error("Já existe uma conta com este e-mail."), { code: "email_exists" });
        throw error;
      }
      return this.getCustomerById(id);
    },
    async getCustomerByEmail(email, { includePassword = false } = {}) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT id,first_name,last_name,email,phone,email_verified_at,marketing_consent,created_at${includePassword ? ",password_hash" : ""}
         FROM galatic_customers WHERE email=?`, [email],
      );
      return row ? { ...customerView(row), ...(includePassword ? { password_hash: row.password_hash } : {}) } : null;
    },
    async getCustomerById(id, { includePassword = false } = {}) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT id,first_name,last_name,email,phone,email_verified_at,marketing_consent,created_at${includePassword ? ",password_hash" : ""}
         FROM galatic_customers WHERE id=?`, [id],
      );
      return row ? { ...customerView(row), ...(includePassword ? { password_hash: row.password_hash } : {}) } : null;
    },
    async createCustomerSession({ customerId, tokenHash, expiresAt }) {
      await ensureSchema();
      const id = randomUUID();
      await pool.query(
        "INSERT INTO galatic_customer_sessions (id,customer_id,token_hash,expires_at) VALUES (?,?,?,?)",
        [id, customerId, tokenHash, expiresAt],
      );
      return id;
    },
    async customerForSession(tokenHash) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT c.id,c.first_name,c.last_name,c.email,c.phone,c.email_verified_at,c.marketing_consent,c.created_at,s.id session_id
         FROM galatic_customer_sessions s JOIN galatic_customers c ON c.id=s.customer_id
         WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(3)`, [tokenHash],
      );
      if (!row) return null;
      await pool.query("UPDATE galatic_customer_sessions SET last_seen_at=UTC_TIMESTAMP(3) WHERE id=?", [row.session_id]);
      return { customer: customerView(row), sessionId: row.session_id };
    },
    async revokeCustomerSession(tokenHash) {
      await ensureSchema();
      await pool.query("UPDATE galatic_customer_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE token_hash=?", [tokenHash]);
    },
    async revokeOtherCustomerSessions(customerId, keepSessionId = null) {
      await ensureSchema();
      await pool.query(
        `UPDATE galatic_customer_sessions SET revoked_at=UTC_TIMESTAMP(3)
         WHERE customer_id=? AND revoked_at IS NULL AND (? IS NULL OR id<>?)`,
        [customerId, keepSessionId, keepSessionId],
      );
    },
    async updateCustomerProfile(customerId, { firstName, lastName, phone }) {
      await ensureSchema();
      await pool.query("UPDATE galatic_customers SET first_name=?,last_name=?,phone=? WHERE id=?", [firstName, lastName, phone || null, customerId]);
      return this.getCustomerById(customerId);
    },
    async updateCustomerPassword(customerId, passwordHash) {
      await ensureSchema();
      await pool.query("UPDATE galatic_customers SET password_hash=? WHERE id=?", [passwordHash, customerId]);
    },
    async createCustomerToken({ customerId, purpose, tokenHash, expiresAt }) {
      await ensureSchema();
      await pool.query("DELETE FROM galatic_customer_tokens WHERE customer_id=? AND purpose=? AND consumed_at IS NULL", [customerId, purpose]);
      await pool.query(
        "INSERT INTO galatic_customer_tokens (token_hash,customer_id,purpose,expires_at) VALUES (?,?,?,?)",
        [tokenHash, customerId, purpose, expiresAt],
      );
    },
    async consumeCustomerToken(tokenHash, purpose) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[token]] = await connection.query(
          `SELECT customer_id FROM galatic_customer_tokens
           WHERE token_hash=? AND purpose=? AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE`,
          [tokenHash, purpose],
        );
        if (!token) { await connection.rollback(); return null; }
        await connection.query("UPDATE galatic_customer_tokens SET consumed_at=UTC_TIMESTAMP(3) WHERE token_hash=?", [tokenHash]);
        if (purpose === "verify_email") await connection.query(
          "UPDATE galatic_customers SET email_verified_at=COALESCE(email_verified_at,UTC_TIMESTAMP(3)) WHERE id=?", [token.customer_id],
        );
        await connection.commit();
        return token.customer_id;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    async listCustomerOrders(customer) {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT id,created_at,payment_status,fulfillment_status,total_cents,subtotal_cents,shipping_cents,
                payment_method,installments,payment_fee_cents,shipping_address_json
         FROM galatic_orders WHERE customer_id=? OR (customer_id IS NULL AND buyer_email=?)
         ORDER BY created_at DESC LIMIT 100`, [customer.id, customer.email],
      );
      return rows.map((row) => ({
        order_number: row.id, created_at: row.created_at, payment_status: row.payment_status,
        shipping_status: row.fulfillment_status, total: Number(row.total_cents), subtotal: Number(row.subtotal_cents),
        shipping_amount: Number(row.shipping_cents), discount_amount: 0, payment_fee_amount: Number(row.payment_fee_cents), currency: "BRL",
        shipping_service_name: "Entrega Galatic", payment_method: row.payment_method, installments: Number(row.installments),
      }));
    },
    async getCustomerOrder(customer, orderId) {
      await ensureSchema();
      const [[order]] = await pool.query(
        `SELECT id,created_at,payment_status,payment_method,installments,fulfillment_status,paid_at,buyer_name,
                shipping_address_json,subtotal_cents,shipping_cents,discount_cents,payment_fee_cents,total_cents
         FROM galatic_orders WHERE id=? AND (customer_id=? OR (customer_id IS NULL AND buyer_email=?))`,
        [orderId, customer.id, customer.email],
      );
      if (!order) return null;
      const [items] = await pool.query(
        "SELECT sku,title name,quantity,total_amount_cents total FROM galatic_order_items WHERE order_id=? ORDER BY id", [orderId],
      );
      return { order: {
        order_number: order.id, created_at: order.created_at, paid_at: order.paid_at,
        payment_status: order.payment_status, payment_method: order.payment_method, installments: Number(order.installments),
        shipping_status: order.fulfillment_status, shipping_service_name: "Entrega Galatic", customer_name: order.buyer_name,
        shipping_address: typeof order.shipping_address_json === "string" ? JSON.parse(order.shipping_address_json) : order.shipping_address_json,
        subtotal: Number(order.subtotal_cents), shipping_amount: Number(order.shipping_cents),
        discount_amount: Number(order.discount_cents), payment_fee_amount: Number(order.payment_fee_cents), total: Number(order.total_cents), currency: "BRL",
      }, items: items.map((item) => ({ ...item, quantity: Number(item.quantity), total: Number(item.total) })), tracking: [] };
    },
    async lookupOrder(orderId, email) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT id order_number,created_at,payment_status,fulfillment_status shipping_status,total_cents total,
                shipping_cents shipping_amount,'BRL' currency
         FROM galatic_orders WHERE id=? AND buyer_email=?`, [orderId, email],
      );
      return row ? { ...row, total: Number(row.total), shipping_amount: Number(row.shipping_amount), shipping_service_name: "Entrega Galatic" } : null;
    },
    async listCustomerAddresses(customerId) {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT id,label,recipient_name,federal_tax_id,postal_code,street,number,complement,district,city,state,is_default
         FROM galatic_customer_addresses WHERE customer_id=? ORDER BY is_default DESC,created_at DESC`, [customerId],
      );
      return rows.map((row) => ({ ...row, is_default: Boolean(row.is_default) }));
    },
    async createCustomerAddress(customerId, address) {
      await ensureSchema();
      const id = randomUUID();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (address.isDefault) await connection.query("UPDATE galatic_customer_addresses SET is_default=0 WHERE customer_id=?", [customerId]);
        await connection.query(
          `INSERT INTO galatic_customer_addresses
           (id,customer_id,label,recipient_name,federal_tax_id,postal_code,street,number,complement,district,city,state,is_default)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, customerId, address.label, address.recipientName, address.federalTaxId || null, address.postalCode,
            address.street, address.number, address.complement || null, address.district, address.city, address.state, address.isDefault ? 1 : 0],
        );
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
      return id;
    },
    async deleteCustomerAddress(customerId, addressId) {
      await ensureSchema();
      const [result] = await pool.query("DELETE FROM galatic_customer_addresses WHERE id=? AND customer_id=?", [addressId, customerId]);
      return result.affectedRows > 0;
    },
    async getCustomerPreferences(customerId) {
      await ensureSchema();
      const [[row]] = await pool.query("SELECT newsletter_enabled,newsletter_status FROM galatic_customers WHERE id=?", [customerId]);
      return { newsletter_enabled: Boolean(row?.newsletter_enabled), newsletter_status: row?.newsletter_status ?? "disabled" };
    },
    async setCustomerPreferences(customerId, enabled) {
      await ensureSchema();
      await pool.query("UPDATE galatic_customers SET newsletter_enabled=?,newsletter_status=? WHERE id=?", [enabled ? 1 : 0, enabled ? "active" : "disabled", customerId]);
      return this.getCustomerPreferences(customerId);
    },
    async upsertNewsletter(email, enabled = true, customerId = null) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO galatic_newsletter_subscribers (email,status,customer_id) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE status=VALUES(status),customer_id=COALESCE(VALUES(customer_id),customer_id)`,
        [email, enabled ? "active" : "unsubscribed", customerId],
      );
    },
    async createContactMessage({ customerId = null, name, email, subject, message }) {
      await ensureSchema();
      const id = randomUUID();
      await pool.query(
        "INSERT INTO galatic_contact_messages (id,customer_id,name,email,subject,message) VALUES (?,?,?,?,?,?)",
        [id, customerId, name, email, subject, message],
      );
      return id;
    },
    async listCatalogProducts() {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT sku,slug,title name,description,image_url,category_name category,brand,unit_amount_cents unit_amount,currency,
                active,manage_stock,stock_quantity FROM galatic_products ORDER BY title`,
      );
      return rows.map((row) => ({ ...row, unit_amount: Number(row.unit_amount), currency: String(row.currency).toLowerCase(),
        available: Boolean(row.active) && (!row.manage_stock || Number(row.stock_quantity) > 0) }));
    },
    async getCatalogProduct(slug) {
      const products = await this.listCatalogProducts();
      return products.find((product) => product.slug === slug || product.sku === String(slug).toUpperCase()) ?? null;
    },
    async close() { await pool.end(); },
  };
}
