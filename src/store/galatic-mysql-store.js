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
        `CREATE TABLE IF NOT EXISTS galatic_admin_users (
          id CHAR(36) PRIMARY KEY, name VARCHAR(160) NOT NULL, email VARCHAR(160) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL, role VARCHAR(24) NOT NULL DEFAULT 'owner',
          status VARCHAR(24) NOT NULL DEFAULT 'active', last_login_at DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_admin_sessions (
          id CHAR(36) PRIMARY KEY, admin_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
          expires_at DATETIME(3) NOT NULL, revoked_at DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_admin_sessions_lookup (token_hash,revoked_at,expires_at),
          CONSTRAINT galatic_admin_sessions_user_fk FOREIGN KEY (admin_id) REFERENCES galatic_admin_users(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_coupons (
          code VARCHAR(40) PRIMARY KEY, description VARCHAR(255) NULL,
          discount_type VARCHAR(16) NOT NULL, discount_value INT UNSIGNED NOT NULL,
          minimum_cents INT UNSIGNED NOT NULL DEFAULT 0, usage_limit INT UNSIGNED NULL,
          per_customer_limit INT UNSIGNED NOT NULL DEFAULT 1, used_count INT UNSIGNED NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_tracking_events (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL,
          status VARCHAR(32) NOT NULL, tracking_code VARCHAR(100) NULL, description VARCHAR(500) NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_tracking_order_time (order_id,created_at),
          CONSTRAINT galatic_tracking_order_fk FOREIGN KEY (order_id) REFERENCES galatic_orders(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_shipments (
          id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL UNIQUE,
          provider VARCHAR(24) NOT NULL DEFAULT 'envia', provider_shipment_id VARCHAR(100) NULL UNIQUE,
          carrier VARCHAR(60) NOT NULL, service VARCHAR(100) NOT NULL,
          tracking_code VARCHAR(100) NOT NULL UNIQUE, label_url VARCHAR(1500) NULL, track_url VARCHAR(1500) NULL,
          provider_cost_cents INT UNSIGNED NULL, currency CHAR(3) NOT NULL DEFAULT 'BRL', status VARCHAR(32) NOT NULL DEFAULT 'label_created',
          canceled_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          INDEX galatic_shipments_status (status,updated_at),
          CONSTRAINT galatic_shipments_order_fk FOREIGN KEY (order_id) REFERENCES galatic_orders(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_shipping_webhook_events (
          event_id VARCHAR(160) PRIMARY KEY, tracking_code VARCHAR(100) NULL,
          event_type VARCHAR(80) NOT NULL, received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX galatic_shipping_webhook_tracking (tracking_code,received_at)
        )`,
        `CREATE TABLE IF NOT EXISTS galatic_admin_emails (
          id CHAR(36) PRIMARY KEY, recipient VARCHAR(160) NOT NULL, subject VARCHAR(160) NOT NULL,
          template_key VARCHAR(48) NOT NULL, message TEXT NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'pending',
          error_message VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          sent_at DATETIME(3) NULL, INDEX galatic_admin_emails_status_time (status,created_at)
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
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS tracking_code VARCHAR(100) NULL AFTER paid_at",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(40) NULL AFTER discount_cents",
        "ALTER TABLE galatic_orders ADD COLUMN IF NOT EXISTS coupon_redeemed TINYINT(1) NOT NULL DEFAULT 0 AFTER coupon_code",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS cost_amount_cents INT UNSIGNED NULL AFTER unit_amount_cents",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS source_url VARCHAR(1000) NULL AFTER image_url",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS editorial_status VARCHAR(24) NOT NULL DEFAULT 'draft' AFTER source_url",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS seo_title VARCHAR(70) NULL AFTER editorial_status",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS seo_description VARCHAR(170) NULL AFTER seo_title",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS fiscal_status VARCHAR(24) NOT NULL DEFAULT 'pending' AFTER seo_description",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS fiscal_ncm CHAR(8) NULL AFTER fiscal_status",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS fiscal_reference_url VARCHAR(1000) NULL AFTER fiscal_ncm",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS merchant_identifier_status VARCHAR(24) NOT NULL DEFAULT 'unknown' AFTER fiscal_reference_url",
        "ALTER TABLE galatic_products ADD COLUMN IF NOT EXISTS fiscal_json JSON NULL AFTER merchant_identifier_status",
        "ALTER TABLE galatic_contact_messages ADD COLUMN IF NOT EXISTS admin_notes TEXT NULL AFTER message",
        "ALTER TABLE galatic_customers ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'active' AFTER newsletter_status",
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
    async prepareOrder({ key, fingerprint, items, quoteId, buyer, paymentMethod = "pix", installments = 1, couponCode = null }) {
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
        let discountCents = 0; let normalizedCoupon = null;
        if (couponCode) {
          normalizedCoupon = String(couponCode).trim().toUpperCase();
          const [[coupon]] = await connection.query("SELECT * FROM galatic_coupons WHERE code=? AND active=1 FOR UPDATE", [normalizedCoupon]);
          if (!coupon || Number(coupon.minimum_cents) > subtotalCents || (coupon.usage_limit !== null && Number(coupon.used_count) >= Number(coupon.usage_limit))) {
            throw Object.assign(new Error("invalid_coupon"), { code: "invalid_coupon" });
          }
          const [[usage]] = await connection.query(
            "SELECT COUNT(*) total FROM galatic_orders WHERE buyer_email=? AND coupon_code=? AND coupon_redeemed=1", [buyer.email, normalizedCoupon],
          );
          if (Number(usage.total) >= Number(coupon.per_customer_limit)) throw Object.assign(new Error("coupon_limit_reached"), { code: "invalid_coupon" });
          discountCents = coupon.discount_type === "percent"
            ? Math.floor(subtotalCents * Math.min(100, Number(coupon.discount_value)) / 100)
            : Math.min(subtotalCents, Number(coupon.discount_value));
        }
        const totalCents = subtotalCents - discountCents + shippingCents;
        if (totalCents < 50) throw Object.assign(new Error("checkout_below_minimum"), { code: "invalid_coupon" });
        await connection.query(
          `INSERT INTO galatic_orders
           (id,customer_id,payment_provider,payment_status,payment_method,installments,buyer_email,buyer_name,buyer_document,buyer_phone,shipping_address_json,
            shipping_quote_id,subtotal_cents,shipping_cents,discount_cents,coupon_code,total_cents)
           VALUES (?,?,'asaas','pending',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId, matchedCustomer?.id ?? null, paymentMethod, installments, buyer.email, buyer.name, buyer.document, buyer.phone,
            JSON.stringify(buyer.address), quoteId, subtotalCents, shippingCents, discountCents, normalizedCoupon, totalCents],
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
        return { kind: "created", order: { id: orderId, subtotalCents, shippingCents, discountCents, couponCode: normalizedCoupon, totalCents, serviceName: quote.service_name, lines: lines.map((line) => ({ sku: line.product.sku, title: line.product.title, quantity: line.quantity, unitAmountCents: Number(line.product.unit_amount_cents) })) } };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    },
    async attachPayment(orderId, providerOrderId, status, details = {}) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(
          `UPDATE galatic_orders SET payment_provider_order_id=?,payment_status=?,payment_method=?,installments=?,
           installment_amount_cents=?,payment_fee_cents=?,payment_provider_group_id=?,total_cents=COALESCE(?,total_cents),
           paid_at=CASE WHEN ?='paid' THEN UTC_TIMESTAMP(3) ELSE paid_at END WHERE id=?`,
          [providerOrderId, status, details.method ?? "pix", details.installments ?? 1,
            details.installmentAmountCents ?? null, details.paymentFeeCents ?? 0, details.providerGroupId ?? null, details.totalCents ?? null, status, orderId],
        );
        const [[order]] = await connection.query("SELECT coupon_code,coupon_redeemed FROM galatic_orders WHERE id=? FOR UPDATE", [orderId]);
        if (status === "paid" && order?.coupon_code && !order.coupon_redeemed) {
          await connection.query("UPDATE galatic_coupons SET used_count=used_count+1 WHERE code=?", [order.coupon_code]);
          await connection.query("UPDATE galatic_orders SET coupon_redeemed=1 WHERE id=?", [orderId]);
        }
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
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
          `SELECT id,payment_status,coupon_code,coupon_redeemed FROM galatic_orders
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
          if (resolvedStatus === "paid" && previousStatus !== "paid" && order.coupon_code && !order.coupon_redeemed) {
            await connection.query("UPDATE galatic_coupons SET used_count=used_count+1 WHERE code=?", [order.coupon_code]);
            await connection.query("UPDATE galatic_orders SET coupon_redeemed=1 WHERE id=?", [order.id]);
          }
          if (["refunded","chargeback"].includes(resolvedStatus) && order.coupon_code && order.coupon_redeemed) {
            await connection.query("UPDATE galatic_coupons SET used_count=GREATEST(used_count-1,0) WHERE code=?", [order.coupon_code]);
            await connection.query("UPDATE galatic_orders SET coupon_redeemed=0 WHERE id=?", [order.id]);
          }
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
        `SELECT o.id,o.created_at,o.payment_status,o.fulfillment_status,o.total_cents,o.subtotal_cents,o.shipping_cents,
                o.payment_method,o.installments,o.payment_fee_cents,o.shipping_address_json,o.tracking_code,
                COALESCE(q.service_name,'Entrega via Envia') shipping_service_name
         FROM galatic_orders o
         LEFT JOIN galatic_shipping_quotes q ON q.id=o.shipping_quote_id
         WHERE o.customer_id=? OR (o.customer_id IS NULL AND o.buyer_email=?)
         ORDER BY o.created_at DESC LIMIT 100`, [customer.id, customer.email],
      );
      return rows.map((row) => ({
        order_number: row.id, created_at: row.created_at, payment_status: row.payment_status,
        shipping_status: row.fulfillment_status, total: Number(row.total_cents), subtotal: Number(row.subtotal_cents),
        shipping_amount: Number(row.shipping_cents), discount_amount: 0, payment_fee_amount: Number(row.payment_fee_cents), currency: "BRL",
        shipping_service_name: row.shipping_service_name, tracking_code: row.tracking_code,
        payment_method: row.payment_method, installments: Number(row.installments),
      }));
    },
    async getCustomerOrder(customer, orderId) {
      await ensureSchema();
      const [[order]] = await pool.query(
        `SELECT o.id,o.created_at,o.payment_status,o.payment_method,o.installments,o.fulfillment_status,o.paid_at,o.buyer_name,
                o.shipping_address_json,o.subtotal_cents,o.shipping_cents,o.discount_cents,o.payment_fee_cents,o.total_cents,
                o.tracking_code,COALESCE(q.service_name,'Entrega via Envia') shipping_service_name
         FROM galatic_orders o
         LEFT JOIN galatic_shipping_quotes q ON q.id=o.shipping_quote_id
         WHERE o.id=? AND (o.customer_id=? OR (o.customer_id IS NULL AND o.buyer_email=?))`,
        [orderId, customer.id, customer.email],
      );
      if (!order) return null;
      const [items] = await pool.query(
        "SELECT sku,title name,quantity,total_amount_cents total FROM galatic_order_items WHERE order_id=? ORDER BY id", [orderId],
      );
      const [tracking] = await pool.query("SELECT status,tracking_code,description,created_at FROM galatic_tracking_events WHERE order_id=? ORDER BY created_at", [orderId]);
      return { order: {
        order_number: order.id, created_at: order.created_at, paid_at: order.paid_at,
        payment_status: order.payment_status, payment_method: order.payment_method, installments: Number(order.installments),
        shipping_status: order.fulfillment_status, shipping_service_name: order.shipping_service_name,
        tracking_code: order.tracking_code, customer_name: order.buyer_name,
        shipping_address: typeof order.shipping_address_json === "string" ? JSON.parse(order.shipping_address_json) : order.shipping_address_json,
        subtotal: Number(order.subtotal_cents), shipping_amount: Number(order.shipping_cents),
        discount_amount: Number(order.discount_cents), payment_fee_amount: Number(order.payment_fee_cents), total: Number(order.total_cents), currency: "BRL",
      }, items: items.map((item) => ({ ...item, quantity: Number(item.quantity), total: Number(item.total) })), tracking };
    },
    async lookupOrder(orderId, email) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT o.id order_number,o.created_at,o.payment_status,o.fulfillment_status shipping_status,o.total_cents total,
                o.shipping_cents shipping_amount,o.tracking_code,COALESCE(q.service_name,'Entrega via Envia') shipping_service_name,
                'BRL' currency
         FROM galatic_orders o
         LEFT JOIN galatic_shipping_quotes q ON q.id=o.shipping_quote_id
         WHERE o.id=? AND o.buyer_email=?`, [orderId, email],
      );
      return row ? { ...row, total: Number(row.total), shipping_amount: Number(row.shipping_amount) } : null;
    },
    async trackingForOrder(orderId) {
      await ensureSchema();
      const [rows] = await pool.query("SELECT status,tracking_code,description,created_at FROM galatic_tracking_events WHERE order_id=? ORDER BY created_at", [orderId]);
      return rows;
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
    async getAdminByEmail(email, { includePassword = false } = {}) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT id,name,email,role,status,last_login_at,created_at${includePassword ? ",password_hash" : ""}
         FROM galatic_admin_users WHERE email=?`, [email],
      );
      return row ?? null;
    },
    async createInitialAdmin({ name, email, passwordHash }) {
      await ensureSchema();
      const id = randomUUID();
      await pool.query(
        `INSERT INTO galatic_admin_users (id,name,email,password_hash,role,status)
         VALUES (?,?,?,?, 'owner','active') ON DUPLICATE KEY UPDATE email=VALUES(email)`,
        [id, name, email, passwordHash],
      );
      return this.getAdminByEmail(email);
    },
    async createAdminSession({ adminId, tokenHash, expiresAt }) {
      await ensureSchema();
      await pool.query("INSERT INTO galatic_admin_sessions (id,admin_id,token_hash,expires_at) VALUES (?,?,?,?)",
        [randomUUID(), adminId, tokenHash, expiresAt]);
      await pool.query("UPDATE galatic_admin_users SET last_login_at=NOW(3) WHERE id=?", [adminId]);
    },
    async adminForSession(sessionTokenHash) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT a.id,a.name,a.email,a.role,a.status,a.last_login_at,s.id session_id
         FROM galatic_admin_sessions s JOIN galatic_admin_users a ON a.id=s.admin_id
         WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>NOW(3) AND a.status='active'`, [sessionTokenHash],
      );
      return row ?? null;
    },
    async revokeAdminSession(sessionTokenHash) {
      await ensureSchema();
      await pool.query("UPDATE galatic_admin_sessions SET revoked_at=NOW(3) WHERE token_hash=?", [sessionTokenHash]);
    },
    async adminDashboard() {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT COUNT(*) orders_today,
          COALESCE(SUM(CASE WHEN payment_status='paid' THEN total_cents ELSE 0 END),0) revenue_today,
          SUM(CASE WHEN payment_status='paid' AND fulfillment_status NOT IN ('delivered','returned','canceled') THEN 1 ELSE 0 END) pending_shipments
         FROM galatic_orders WHERE created_at>=UTC_DATE()`,
      );
      return { orders_today: Number(row.orders_today), revenue_today: Number(row.revenue_today), pending_shipments: Number(row.pending_shipments) };
    },
    async adminListProducts() {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT sku,slug,title name,description,image_url,source_url,category_name category,brand,
          unit_amount_cents unit_amount,cost_amount_cents cost_amount,currency,active,manage_stock,
          stock_quantity,0 reserved_quantity,weight_grams,length_cm,width_cm,height_cm,editorial_status,updated_at
         FROM galatic_products ORDER BY title`,
      );
      return rows.map((row) => ({ ...row, unit_amount: Number(row.unit_amount), cost_amount: row.cost_amount === null ? null : Number(row.cost_amount),
        active: Number(row.active), manage_stock: Number(row.manage_stock), stock_quantity: row.stock_quantity === null ? null : Number(row.stock_quantity), reserved_quantity: 0 }));
    },
    async adminUpsertProduct(product, { create = false } = {}) {
      await ensureSchema();
      if (create) {
        await pool.query(
          `INSERT INTO galatic_products
           (sku,slug,title,description,image_url,source_url,category_name,brand,unit_amount_cents,cost_amount_cents,
            active,manage_stock,stock_quantity,weight_grams,length_cm,width_cm,height_cm,editorial_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [product.sku, product.slug, product.name, product.description || null, product.imageUrl || null, product.sourceUrl || null,
            product.category || null, product.brand || null, product.unitAmount, product.costAmount, product.active ? 1 : 0,
            product.manageStock ? 1 : 0, product.stockQuantity, product.weightGrams, product.lengthCm, product.widthCm,
            product.heightCm, product.editorialStatus || "draft"],
        );
      } else {
        const [result] = await pool.query(
          `UPDATE galatic_products SET slug=?,title=?,description=?,image_url=?,source_url=?,category_name=?,brand=?,
           unit_amount_cents=?,cost_amount_cents=?,active=?,manage_stock=?,stock_quantity=?,weight_grams=?,length_cm=?,
           width_cm=?,height_cm=?,editorial_status=? WHERE sku=?`,
          [product.slug, product.name, product.description || null, product.imageUrl || null, product.sourceUrl || null,
            product.category || null, product.brand || null, product.unitAmount, product.costAmount, product.active ? 1 : 0,
            product.manageStock ? 1 : 0, product.stockQuantity, product.weightGrams, product.lengthCm, product.widthCm,
            product.heightCm, product.editorialStatus || "draft", product.sku],
        );
        if (!result.affectedRows) return false;
      }
      return true;
    },
    async adminBulkLogistics(products) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const product of products) {
          const [result] = await connection.query(
            `UPDATE galatic_products SET weight_grams=?,length_cm=?,width_cm=?,height_cm=?,stock_quantity=? WHERE sku=?`,
            [product.weight_grams, product.length_cm, product.width_cm, product.height_cm, product.stock_quantity, product.sku],
          );
          if (!result.affectedRows) throw Object.assign(new Error("unknown_product"), { code: "unknown_product" });
        }
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
      return products.length;
    },
    async adminListOrders() {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT id order_number,buyer_name customer_name,buyer_email customer_email,total_cents total,'BRL' currency,
          payment_status,fulfillment_status shipping_status,created_at FROM galatic_orders ORDER BY created_at DESC LIMIT 500`,
      );
      return rows.map((row) => ({ ...row, total: Number(row.total) }));
    },
    async adminOrder(orderId) {
      await ensureSchema();
      const [[order]] = await pool.query(
        `SELECT id order_number,buyer_name customer_name,buyer_email customer_email,payment_status,
          fulfillment_status status,fulfillment_status shipping_status,total_cents total,'BRL' currency,
          payment_provider,payment_provider_order_id provider_order_id,payment_method provider_payment_method,
          'envia' shipping_provider,'pending' fiscal_status,tracking_code,created_at
         FROM galatic_orders WHERE id=?`, [orderId],
      );
      if (!order) return null;
      const [items] = await pool.query(
        `SELECT sku,title name,quantity,total_amount_cents total FROM galatic_order_items WHERE order_id=? ORDER BY id`, [orderId],
      );
      const [tracking] = await pool.query(
        `SELECT status,tracking_code,description,created_at FROM galatic_tracking_events WHERE order_id=? ORDER BY created_at`, [orderId],
      );
      const [shipments] = await pool.query(
        `SELECT provider,carrier,service,tracking_code,label_url,track_url,status,created_at,updated_at,canceled_at
           FROM galatic_shipments WHERE order_id=? ORDER BY created_at`, [orderId],
      );
      return { order: { ...order, total: Number(order.total), shipping_service_name: "Entrega via Envia" },
        items: items.map((item) => ({ ...item, quantity: Number(item.quantity), total: Number(item.total) })), shipments, tracking };
    },
    async adminUpdateShipping(orderId, { status, trackingCode = null, description = null }) {
      await ensureSchema();
      const [result] = await pool.query(
        "UPDATE galatic_orders SET fulfillment_status=?,tracking_code=COALESCE(?,tracking_code) WHERE id=? AND payment_status='paid'",
        [status, trackingCode, orderId],
      );
      if (!result.affectedRows) return false;
      await pool.query("INSERT INTO galatic_tracking_events (order_id,status,tracking_code,description) VALUES (?,?,?,?)",
        [orderId, status, trackingCode, description]);
      return true;
    },
    async shipmentCreationContext(orderId) {
      await ensureSchema();
      const [[order]] = await pool.query(
        `SELECT o.id,o.payment_status,o.fulfillment_status,o.buyer_name,o.buyer_email,o.buyer_phone,o.buyer_document,
                o.shipping_address_json,q.service_code,q.service_name
           FROM galatic_orders o LEFT JOIN galatic_shipping_quotes q ON q.id=o.shipping_quote_id WHERE o.id=?`, [orderId],
      );
      if (!order) return null;
      const [items] = await pool.query(
        `SELECT i.sku,i.title,i.quantity,i.unit_amount_cents,p.weight_grams,p.length_cm,p.width_cm,p.height_cm
           FROM galatic_order_items i JOIN galatic_products p ON p.sku=i.sku WHERE i.order_id=? ORDER BY i.id`, [orderId],
      );
      return { ...order, shipping_address: typeof order.shipping_address_json === "string" ? JSON.parse(order.shipping_address_json) : order.shipping_address_json,
        items: items.map((item) => ({ ...item, quantity: Number(item.quantity), unit_amount_cents: Number(item.unit_amount_cents),
          weight_grams: Number(item.weight_grams), length_cm: Number(item.length_cm), width_cm: Number(item.width_cm), height_cm: Number(item.height_cm) })) };
    },
    async shipmentForOrder(orderId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT id,order_id,provider,provider_shipment_id,carrier,service,tracking_code,label_url,track_url,
                provider_cost_cents,currency,status,canceled_at,created_at,updated_at FROM galatic_shipments WHERE order_id=?`, [orderId],
      );
      return row ? { ...row, provider_cost_cents: row.provider_cost_cents === null ? null : Number(row.provider_cost_cents) } : null;
    },
    async saveShipment(orderId, shipment) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[existing]] = await connection.query("SELECT id FROM galatic_shipments WHERE order_id=? FOR UPDATE", [orderId]);
        if (existing) { await connection.rollback(); return this.shipmentForOrder(orderId); }
        const id = randomUUID();
        await connection.query(
          `INSERT INTO galatic_shipments
             (id,order_id,provider_shipment_id,carrier,service,tracking_code,label_url,track_url,provider_cost_cents,currency,status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [id, orderId, shipment.providerShipmentId, shipment.carrier, shipment.service, shipment.trackingCode,
            shipment.labelUrl, shipment.trackUrl, shipment.costCents, shipment.currency, "label_created"],
        );
        await connection.query("UPDATE galatic_orders SET fulfillment_status='label_created',tracking_code=? WHERE id=? AND payment_status='paid'", [shipment.trackingCode, orderId]);
        await connection.query("INSERT INTO galatic_tracking_events (order_id,status,tracking_code,description) VALUES (?,?,?,?)",
          [orderId, "label_created", shipment.trackingCode, "Etiqueta de envio gerada."]);
        await connection.commit();
        return this.shipmentForOrder(orderId);
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    async updateShipmentFromEvent({ eventId, eventType, trackingCode, status, description }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [dedupe] = await connection.query(
          "INSERT IGNORE INTO galatic_shipping_webhook_events (event_id,tracking_code,event_type) VALUES (?,?,?)",
          [eventId, trackingCode || null, eventType],
        );
        if (!dedupe.affectedRows) { await connection.rollback(); return { duplicate: true }; }
        const [[shipment]] = await connection.query("SELECT order_id FROM galatic_shipments WHERE tracking_code=? FOR UPDATE", [trackingCode]);
        if (!shipment) { await connection.commit(); return { ignored: true }; }
        await connection.query("UPDATE galatic_shipments SET status=? WHERE tracking_code=?", [status, trackingCode]);
        await connection.query("UPDATE galatic_orders SET fulfillment_status=? WHERE id=?", [status, shipment.order_id]);
        await connection.query("INSERT INTO galatic_tracking_events (order_id,status,tracking_code,description) VALUES (?,?,?,?)",
          [shipment.order_id, status, trackingCode, description || null]);
        await connection.commit();
        return { updated: true, orderId: shipment.order_id };
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    async cancelShipment(orderId, description = "Etiqueta cancelada.") {
      await ensureSchema();
      const [result] = await pool.query("UPDATE galatic_shipments SET status='canceled',canceled_at=NOW(3) WHERE order_id=? AND canceled_at IS NULL", [orderId]);
      if (!result.affectedRows) return false;
      await pool.query("UPDATE galatic_orders SET fulfillment_status='shipment_canceled' WHERE id=?", [orderId]);
      await pool.query("INSERT INTO galatic_tracking_events (order_id,status,tracking_code,description) SELECT order_id,'shipment_canceled',tracking_code,? FROM galatic_shipments WHERE order_id=?", [description, orderId]);
      return true;
    },
    async adminListCustomers() {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT c.id,CONCAT(c.first_name,' ',c.last_name) name,c.email,c.phone,c.status,c.email_verified_at,
          COUNT(o.id) orders_count,COALESCE(SUM(CASE WHEN o.payment_status='paid' THEN o.total_cents ELSE 0 END),0) total_spent,c.created_at
         FROM galatic_customers c LEFT JOIN galatic_orders o ON o.customer_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`,
      );
      return rows.map((row) => ({ ...row, orders_count: Number(row.orders_count), total_spent: Number(row.total_spent) }));
    },
    async adminCustomer(customerId) {
      await ensureSchema();
      const [[customer]] = await pool.query(
        `SELECT id,CONCAT(first_name,' ',last_name) name,email,phone,status,email_verified_at,marketing_consent,created_at
         FROM galatic_customers WHERE id=?`, [customerId],
      );
      if (!customer) return null;
      const [orders] = await pool.query("SELECT id order_number,payment_status,total_cents total,created_at FROM galatic_orders WHERE customer_id=? ORDER BY created_at DESC", [customerId]);
      return { customer, orders: orders.map((row) => ({ ...row, total: Number(row.total) })) };
    },
    async adminUpdateCustomerStatus(customerId, status) {
      await ensureSchema();
      const [result] = await pool.query("UPDATE galatic_customers SET status=? WHERE id=?", [status, customerId]);
      if (status !== "active") await pool.query("UPDATE galatic_customer_sessions SET revoked_at=NOW(3) WHERE customer_id=? AND revoked_at IS NULL", [customerId]);
      return result.affectedRows > 0;
    },
    async adminListContacts() {
      await ensureSchema();
      const [rows] = await pool.query("SELECT id,name,email,subject,message,status,admin_notes,created_at FROM galatic_contact_messages ORDER BY created_at DESC LIMIT 500");
      return rows;
    },
    async adminContact(id) {
      await ensureSchema(); const [[row]] = await pool.query("SELECT id,name,email,subject,message,status,admin_notes,created_at FROM galatic_contact_messages WHERE id=?", [id]); return row ?? null;
    },
    async adminUpdateContact(id, status, notes) {
      await ensureSchema(); const [result] = await pool.query("UPDATE galatic_contact_messages SET status=?,admin_notes=? WHERE id=?", [status, notes || null, id]); return result.affectedRows > 0;
    },
    async adminListCoupons() {
      await ensureSchema(); const [rows] = await pool.query("SELECT code,description,discount_type,discount_value,minimum_cents minimum_subtotal,usage_limit,per_customer_limit,used_count usage_count,active,created_at FROM galatic_coupons ORDER BY created_at DESC"); return rows;
    },
    async adminCreateCoupon(coupon) {
      await ensureSchema(); await pool.query("INSERT INTO galatic_coupons (code,description,discount_type,discount_value,minimum_cents,usage_limit,per_customer_limit,active) VALUES (?,?,?,?,?,?,?,1)", [coupon.code,coupon.description||null,coupon.type,coupon.value,coupon.minimum,coupon.limit,coupon.perCustomer]);
    },
    async adminUpdateCoupon(code, coupon) {
      await ensureSchema(); const [result] = await pool.query("UPDATE galatic_coupons SET description=?,discount_type=?,discount_value=?,minimum_cents=?,usage_limit=?,per_customer_limit=?,active=? WHERE code=?", [coupon.description||null,coupon.type,coupon.value,coupon.minimum,coupon.limit,coupon.perCustomer,coupon.active?1:0,code]); return result.affectedRows>0;
    },
    async adminContentFiscal() {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT sku,title name,brand,image_url,editorial_status content_status,seo_title,seo_description,
          fiscal_status,fiscal_ncm,fiscal_reference_url,merchant_identifier_status,fiscal_json,
          weight_grams,length_cm,width_cm,height_cm,active
         FROM galatic_products ORDER BY title`,
      );
      const products = rows.map((row) => {
        const fiscal = typeof row.fiscal_json === "string" ? JSON.parse(row.fiscal_json || "{}") : (row.fiscal_json || {});
        const contentReady = String(row.seo_title || "").length >= 20 && String(row.seo_description || "").length >= 70;
        const logisticsReady = [row.weight_grams,row.length_cm,row.width_cm,row.height_cm].every((value) => Number(value) > 0);
        const merchantReady = Boolean(row.active && contentReady && row.fiscal_status === "verified" && logisticsReady
          && (row.merchant_identifier_status === "none" || fiscal.gtin));
        return { ...row, fiscal_json: undefined, fiscal, content_ready: contentReady, logistics_ready: logisticsReady,
          merchant_ready: merchantReady, merchant: { ready: merchantReady, identifier_status: row.merchant_identifier_status } };
      });
      return { products, summary: { total: products.length,
        content_approved: products.filter((row) => row.content_status === "approved" && row.content_ready).length,
        fiscal_verified: products.filter((row) => row.fiscal_status === "verified").length,
        logistics_ready: products.filter((row) => row.logistics_ready).length,
        merchant_ready: products.filter((row) => row.merchant_ready).length } };
    },
    async adminUpdateContentFiscal(sku, values) {
      await ensureSchema();
      const [result] = await pool.query(
        `UPDATE galatic_products SET seo_title=?,seo_description=?,editorial_status=?,fiscal_status=?,fiscal_ncm=?,
          fiscal_reference_url=?,merchant_identifier_status=?,fiscal_json=? WHERE sku=?`,
        [values.seoTitle || null,values.seoDescription || null,values.contentStatus,values.fiscalStatus,values.ncm || null,
          values.referenceUrl || null,values.identifierStatus,JSON.stringify(values.fiscal),sku],
      );
      return result.affectedRows > 0;
    },
    async adminCreateEmail({ recipient, subject, template, message }) {
      await ensureSchema(); const id = randomUUID();
      await pool.query("INSERT INTO galatic_admin_emails (id,recipient,subject,template_key,message) VALUES (?,?,?,?,?)", [id,recipient,subject,template,message]);
      return id;
    },
    async adminFinishEmail(id, status, errorMessage = null) {
      await ensureSchema(); await pool.query("UPDATE galatic_admin_emails SET status=?,error_message=?,sent_at=CASE WHEN ?='sent' THEN NOW(3) ELSE sent_at END WHERE id=?", [status,errorMessage,status,id]);
    },
    async adminListEmails(status = "") {
      await ensureSchema();
      const [rows] = status ? await pool.query("SELECT id,recipient,subject,template_key template,status,error_message,created_at,sent_at FROM galatic_admin_emails WHERE status=? ORDER BY created_at DESC LIMIT 200", [status])
        : await pool.query("SELECT id,recipient,subject,template_key template,status,error_message,created_at,sent_at FROM galatic_admin_emails ORDER BY created_at DESC LIMIT 200");
      return rows;
    },
    async close() { await pool.end(); },
  };
}
