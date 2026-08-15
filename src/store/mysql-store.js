import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { resolveOrderStatus } from "./order-status.js";
import { summarizeInstallmentPlan } from "../domain/payment-status.js";
import { hardenedPoolOptions } from "./pool-options.js";

const asJson = (value) => JSON.stringify(value ?? []);
const fromJson = (value, fallback = []) => {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const iso = (value) => value ? new Date(value).toISOString() : null;
const coupon = (row) => row && ({
  id: row.id,
  code: row.code,
  discountBps: row.discount_bps,
  active: Boolean(row.active),
  startsAt: iso(row.starts_at),
  endsAt: iso(row.ends_at),
  maxRedemptions: row.max_redemptions,
  productSlugs: fromJson(row.product_scope_json),
  redemptions: Number(row.redemptions ?? 0),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
const paymentInstallment = (row) => row && ({
  providerPaymentId: row.provider_payment_id,
  providerGroupId: row.provider_group_id,
  number: Number(row.installment_number),
  status: row.status,
  dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
  amountCents: Number(row.amount_cents),
  paymentUrl: row.payment_url,
  paidAt: iso(row.paid_at),
});

// Todas as tabelas usam o prefixo academy_ porque o banco é compartilhado com o
// LMS (academy4u.com.br), cujo install.sql cria tabelas próprias — incluindo
// `coupons` e `enrollments`, que colidiriam com nomes sem prefixo.
export function createMySqlStore(databaseUrl) {
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
      const legacyPrefix = [112, 117, 108, 115, 111].map((code) => String.fromCharCode(code)).join("");
      const tableSuffixes = [
        "products", "coupons", "orders", "order_items", "payment_installments",
        "coupon_redemptions", "coupon_reservations", "checkout_attempts",
        "webhook_events", "operational_alerts", "order_deliveries", "order_receipts",
      ];
      const [legacyRows] = await pool.query(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE ?",
        [`${legacyPrefix}\\_%`],
      );
      const legacyTables = new Set(legacyRows.map((row) => row.TABLE_NAME));
      if (legacyTables.size) {
        const [academyRows] = await pool.query(
          "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'academy\\_%'",
        );
        const academyTables = new Set(academyRows.map((row) => row.TABLE_NAME));
        const renames = tableSuffixes
          .map((suffix) => [`${legacyPrefix}_${suffix}`, `academy_${suffix}`])
          .filter(([legacy, academy]) => legacyTables.has(legacy) && !academyTables.has(academy));
        if (renames.length) {
          await pool.query(`RENAME TABLE ${renames.map(([legacy, academy]) => `\`${legacy}\` TO \`${academy}\``).join(", ")}`);
        }
      }
      const statements = [
        `CREATE TABLE IF NOT EXISTS academy_schema_migrations (version INT UNSIGNED PRIMARY KEY, name VARCHAR(120) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS academy_products (slug VARCHAR(80) PRIMARY KEY, source_tag VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, description TEXT NOT NULL, category_id VARCHAR(60) NOT NULL, kind VARCHAR(32) NOT NULL, accent CHAR(7) NULL, cohort VARCHAR(40) NULL, course_year VARCHAR(8) NULL, official_price_cents INT UNSIGNED NOT NULL, price_cents INT UNSIGNED NOT NULL, featured TINYINT(1) NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, image_url VARCHAR(500) NULL, image_600_url VARCHAR(500) NULL, image_alt VARCHAR(255) NULL, keywords_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX academy_products_active_order (active,sort_order,title), UNIQUE INDEX academy_products_source_tag (source_tag))`,
        `CREATE TABLE IF NOT EXISTS academy_coupons (id CHAR(36) PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, discount_bps SMALLINT UNSIGNED NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, starts_at DATETIME(3) NULL, ends_at DATETIME(3) NULL, max_redemptions INT UNSIGNED NULL, product_scope_json JSON NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX academy_coupons_active (active, starts_at, ends_at))`,
        `CREATE TABLE IF NOT EXISTS academy_orders (id CHAR(36) PRIMARY KEY, provider VARCHAR(24) NOT NULL, provider_order_id VARCHAR(80) NOT NULL, provider_group_id VARCHAR(80) NULL, status VARCHAR(32) NOT NULL, buyer_email VARCHAR(160) NULL, buyer_cpf VARCHAR(14) NULL, buyer_name VARCHAR(180) NULL, buyer_phone VARCHAR(13) NULL, buyer_birth_date VARCHAR(10) NULL, buyer_address_json JSON NULL, payment_method VARCHAR(24) NULL, installments TINYINT UNSIGNED NULL, installment_cents INT UNSIGNED NULL, subtotal_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, total_cents INT UNSIGNED NOT NULL, paid_cents INT UNSIGNED NOT NULL DEFAULT 0, paid_installments TINYINT UNSIGNED NOT NULL DEFAULT 0, access_granted_at DATETIME(3) NULL, coupon_code VARCHAR(32) NULL, coupon_redeemed TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX academy_orders_provider_order (provider, provider_order_id), INDEX academy_orders_provider_group (provider, provider_group_id), INDEX academy_orders_status_updated (status, updated_at))`,
        `CREATE TABLE IF NOT EXISTS academy_order_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL, course_slug VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, base_price_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, final_price_cents INT UNSIGNED NOT NULL, CONSTRAINT academy_order_items_order_fk FOREIGN KEY (order_id) REFERENCES academy_orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS academy_payment_installments (id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, provider VARCHAR(24) NOT NULL DEFAULT 'asaas', provider_payment_id VARCHAR(80) NOT NULL, provider_group_id VARCHAR(80) NOT NULL, installment_number TINYINT UNSIGNED NOT NULL, status VARCHAR(24) NOT NULL, due_date DATE NULL, amount_cents INT UNSIGNED NOT NULL DEFAULT 0, payment_url VARCHAR(500) NULL, paid_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX academy_installments_provider_payment (provider, provider_payment_id), UNIQUE INDEX academy_installments_order_number (order_id, installment_number), INDEX academy_installments_order_status (order_id, status, due_date), CONSTRAINT academy_installments_order_fk FOREIGN KEY (order_id) REFERENCES academy_orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS academy_coupon_redemptions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, order_id CHAR(36) NOT NULL UNIQUE, redeemed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX academy_coupon_redemptions_code (coupon_code))`,
        `CREATE TABLE IF NOT EXISTS academy_coupon_reservations (attempt_key CHAR(36) PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, provider VARCHAR(24) NULL, provider_order_id VARCHAR(80) NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX academy_reservations_provider_order (provider, provider_order_id), INDEX academy_reservations_code_expiry (coupon_code, expires_at))`,
        `CREATE TABLE IF NOT EXISTS academy_checkout_attempts (idempotency_key CHAR(36) PRIMARY KEY, fingerprint CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, response_json JSON NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX academy_attempts_expiry (expires_at))`,
        `CREATE TABLE IF NOT EXISTS academy_webhook_events (event_id VARCHAR(128) PRIMARY KEY, received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS academy_operational_alerts (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, alert_type VARCHAR(48) NOT NULL, severity VARCHAR(16) NOT NULL DEFAULT 'error', source VARCHAR(48) NOT NULL, summary VARCHAR(255) NOT NULL, context_json JSON NULL, occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), notified_at DATETIME(3) NULL, INDEX academy_alerts_pending (notified_at, occurred_at), INDEX academy_alerts_type_time (alert_type, occurred_at))`,
        `CREATE TABLE IF NOT EXISTS academy_order_deliveries (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL, order_item_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL, course_id BIGINT UNSIGNED NOT NULL, enrollment_id BIGINT UNSIGNED NULL, enrollment_created TINYINT(1) NOT NULL DEFAULT 0, payment_history_id INT UNSIGNED NULL, refund_payment_history_id INT UNSIGNED NULL, delivered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), revoked_at DATETIME(3) NULL, UNIQUE INDEX academy_deliveries_order_item (order_id,order_item_id), INDEX academy_deliveries_user_course (user_id,course_id), CONSTRAINT academy_deliveries_order_fk FOREIGN KEY (order_id) REFERENCES academy_orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS academy_order_receipts (id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, order_item_id BIGINT UNSIGNED NOT NULL, provider_payment_id VARCHAR(80) NOT NULL, installment_number TINYINT UNSIGNED NOT NULL, amount_cents INT UNSIGNED NOT NULL, payment_history_id INT UNSIGNED NULL, refund_payment_history_id INT UNSIGNED NULL, refund_reason VARCHAR(24) NULL, refunded_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX academy_receipts_payment_item (provider_payment_id,order_item_id), INDEX academy_receipts_order (order_id,installment_number), CONSTRAINT academy_receipts_order_fk FOREIGN KEY (order_id) REFERENCES academy_orders(id) ON DELETE CASCADE)`,
      ];
      for (const sql of statements) await pool.query(sql);
      for (const suffix of tableSuffixes) {
        const legacy = `${legacyPrefix}_${suffix}`;
        const academy = `academy_${suffix}`;
        const [[legacyExists]] = await pool.query(
          "SELECT 1 present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
          [legacy],
        );
        if (!legacyExists) continue;
        const [columns] = await pool.query(
          `SELECT legacy.COLUMN_NAME FROM information_schema.COLUMNS legacy
           INNER JOIN information_schema.COLUMNS academy
             ON academy.TABLE_SCHEMA=legacy.TABLE_SCHEMA AND academy.COLUMN_NAME=legacy.COLUMN_NAME
           WHERE legacy.TABLE_SCHEMA=DATABASE() AND legacy.TABLE_NAME=? AND academy.TABLE_NAME=?
           ORDER BY legacy.ORDINAL_POSITION`,
          [legacy, academy],
        );
        const names = columns.map((row) => `\`${row.COLUMN_NAME}\``).join(",");
        if (names) await pool.query(`INSERT IGNORE INTO \`${academy}\` (${names}) SELECT ${names} FROM \`${legacy}\``);
      }
      for (const suffix of [...tableSuffixes].reverse()) {
        await pool.query(`DROP TABLE IF EXISTS \`${legacyPrefix}_${suffix}\``);
      }
      await pool.query(
        `UPDATE settings AS source_setting
         LEFT JOIN settings AS replacement_setting
           ON replacement_setting.type=CONCAT('academy_',SUBSTRING(source_setting.type,7))
         SET source_setting.type=CONCAT('academy_',SUBSTRING(source_setting.type,7))
         WHERE source_setting.type LIKE ? AND replacement_setting.id IS NULL`,
        [`${legacyPrefix}\\_%`],
      );
      await pool.query("DELETE FROM settings WHERE type LIKE ?", [`${legacyPrefix}\\_%`]);
      const additions = [
        ["academy_orders", "lms_buyer_user_id", "BIGINT UNSIGNED NULL"],
        ["academy_orders", "lms_recipient_user_id", "BIGINT UNSIGNED NULL"],
        ["academy_order_items", "course_id", "BIGINT UNSIGNED NULL"],
        ["academy_order_deliveries", "enrollment_created", "TINYINT(1) NOT NULL DEFAULT 0"],
        ["academy_order_deliveries", "refund_payment_history_id", "INT UNSIGNED NULL"],
        ["academy_order_receipts", "refund_payment_history_id", "INT UNSIGNED NULL"],
        ["academy_order_receipts", "refund_reason", "VARCHAR(24) NULL"],
        ["academy_order_receipts", "refunded_at", "DATETIME(3) NULL"],
      ];
      for (const [table, column, definition] of additions) {
        const [[existing]] = await pool.query(
          "SELECT 1 present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
          [table, column],
        );
        if (!existing) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
      await pool.query(
        "INSERT IGNORE INTO academy_schema_migrations (version,name) VALUES (?,?)",
        [1, "baseline_multi_tenant_payment_schema"],
      );
    })();
    return ready;
  }
  const id = () => crypto.randomUUID();

  async function redeemCoupon(connection, order) {
    if (!order.coupon_code || order.coupon_redeemed) return;
    const [[reservation]] = await connection.query(
      "SELECT attempt_key FROM academy_coupon_reservations WHERE provider=? AND provider_order_id=? FOR UPDATE",
      [order.provider, order.provider_order_id],
    );
    if (!reservation) throw new Error("Paid order has no coupon reservation.");
    await connection.query(
      "INSERT IGNORE INTO academy_coupon_redemptions (coupon_code,order_id) VALUES (?,?)",
      [order.coupon_code, order.id],
    );
    await connection.query("UPDATE academy_orders SET coupon_redeemed=1 WHERE id=?", [order.id]);
    await connection.query(
      "DELETE FROM academy_coupon_reservations WHERE attempt_key=?",
      [reservation.attempt_key],
    );
  }

  async function revenueSplit(connection, course, amountValue) {
    let adminRevenue = amountValue;
    let instructorRevenue = 0;
    if (course.creator_role && course.creator_role !== "admin") {
      const [[setting]] = await connection.query(
        "SELECT description FROM settings WHERE type='instructor_revenue' ORDER BY id ASC LIMIT 1",
      );
      const percentage = Math.max(0, Math.min(100, Number(setting?.description ?? 0)));
      instructorRevenue = Number((amountValue * percentage / 100).toFixed(2));
      adminRevenue = Number((amountValue - instructorRevenue).toFixed(2));
    }
    return { adminRevenue, instructorRevenue };
  }

  async function recordInstallmentReceipts(connection, order, installment) {
    if (
      order.payment_method !== "pix_installment"
      || installment.status !== "paid"
      || !order.lms_recipient_user_id
      || Number(installment.amountCents) <= 0
    ) return 0;

    const [items] = await connection.query(
      `SELECT i.*,c.user_id,u.role creator_role FROM academy_order_items i
       JOIN courses c ON c.id=i.course_id
       LEFT JOIN users u ON u.id=c.user_id
       WHERE i.order_id=? ORDER BY i.id FOR UPDATE`,
      [order.id],
    );
    if (!items.length || Number(order.total_cents) <= 0) return 0;

    let remainingCents = Number(installment.amountCents);
    let receipts = 0;
    const nowUnix = Math.floor(Date.now() / 1000);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const amountCents = index === items.length - 1
        ? remainingCents
        : Math.min(
          remainingCents,
          Math.floor(Number(installment.amountCents) * Number(item.final_price_cents) / Number(order.total_cents)),
        );
      remainingCents -= amountCents;
      if (amountCents <= 0) continue;

      const receiptId = id();
      const [receiptResult] = await connection.query(
        `INSERT IGNORE INTO academy_order_receipts
         (id,order_id,order_item_id,provider_payment_id,installment_number,amount_cents)
         VALUES (?,?,?,?,?,?)`,
        [receiptId, order.id, item.id, installment.providerPaymentId, installment.number, amountCents],
      );
      if (!receiptResult.affectedRows) continue;

      const amountValue = amountCents / 100;
      const { adminRevenue, instructorRevenue } = await revenueSplit(connection, item, amountValue);
      const [historyResult] = await connection.query(
        `INSERT INTO payment_histories
         (user_id,course_id,payment_type,amount,invoice,date_added,last_modified,admin_revenue,instructor_revenue,tax,instructor_payment_status,transaction_id,session_id,coupon,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [
          order.lms_buyer_user_id ?? order.lms_recipient_user_id,
          item.course_id,
          "asaas_pix_installment",
          amountValue,
          `ACADEMY4U-${order.id}-P${installment.number}-${item.id}`.slice(0, 255),
          nowUnix,
          nowUnix,
          adminRevenue,
          instructorRevenue,
          0,
          0,
          installment.providerPaymentId,
          order.id,
          order.coupon_code,
        ],
      );
      await connection.query(
        "UPDATE academy_order_receipts SET payment_history_id=? WHERE id=?",
        [historyResult.insertId, receiptId],
      );
      receipts += 1;
    }
    return receipts;
  }

  async function reverseInstallmentReceipts(connection, order, installment) {
    if (
      order.payment_method !== "pix_installment"
      || !["refunded", "chargeback"].includes(installment.status)
      || !order.lms_recipient_user_id
    ) return 0;

    const [receipts] = await connection.query(
      `SELECT r.*,i.course_id,h.admin_revenue,h.instructor_revenue
       FROM academy_order_receipts r
       JOIN academy_order_items i ON i.id=r.order_item_id
       LEFT JOIN payment_histories h ON h.id=r.payment_history_id
       WHERE r.order_id=? AND r.provider_payment_id=? AND r.refunded_at IS NULL
       ORDER BY r.id FOR UPDATE`,
      [order.id, installment.providerPaymentId],
    );
    const nowUnix = Math.floor(Date.now() / 1000);
    let reversed = 0;
    for (const receipt of receipts) {
      const amountValue = Number(receipt.amount_cents) / -100;
      const adminRevenue = -Math.abs(Number(receipt.admin_revenue ?? -amountValue));
      const instructorRevenue = -Math.abs(Number(receipt.instructor_revenue ?? 0));
      const [historyResult] = await connection.query(
        `INSERT INTO payment_histories
         (user_id,course_id,payment_type,amount,invoice,date_added,last_modified,admin_revenue,instructor_revenue,tax,instructor_payment_status,transaction_id,session_id,coupon,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [
          order.lms_buyer_user_id ?? order.lms_recipient_user_id,
          receipt.course_id,
          `asaas_${installment.status}`.slice(0, 255),
          amountValue,
          `ACADEMY4U-REV-${order.id}-P${receipt.installment_number}-${receipt.order_item_id}`.slice(0, 255),
          nowUnix,
          nowUnix,
          adminRevenue,
          instructorRevenue,
          0,
          0,
          `${installment.providerPaymentId}:${installment.status}`.slice(0, 255),
          order.id,
          order.coupon_code,
        ],
      );
      await connection.query(
        `UPDATE academy_order_receipts SET refund_payment_history_id=?,refund_reason=?,refunded_at=NOW(3)
         WHERE id=? AND refunded_at IS NULL`,
        [historyResult.insertId, installment.status, receipt.id],
      );
      reversed += 1;
    }
    return reversed;
  }

  async function reconcileInstallmentOrder(connection, order) {
    const [storedRows] = await connection.query(
      "SELECT * FROM academy_payment_installments WHERE order_id=? ORDER BY installment_number",
      [order.id],
    );
    const summary = summarizeInstallmentPlan(
      storedRows.map(paymentInstallment),
      Number(order.installments ?? 0),
    );
    const hadAccess = Boolean(order.access_granted_at);
    await connection.query(
      `UPDATE academy_orders SET status=?,paid_cents=?,paid_installments=?,
       access_granted_at=CASE WHEN ? > 0 THEN COALESCE(access_granted_at,NOW(3)) ELSE access_granted_at END
       WHERE id=?`,
      [summary.status, summary.paidCents, summary.paidInstallments, summary.paidInstallments, order.id],
    );
    if (summary.paidInstallments > 0) await redeemCoupon(connection, order);
    return {
      id: order.id,
      status: summary.status,
      previousStatus: order.status,
      accessGrantedNow: !hadAccess && summary.paidInstallments > 0,
    };
  }

  return {
    ensureSchema,
    async recordOperationalAlert(value) {
      await ensureSchema();
      await pool.query(
        "INSERT INTO academy_operational_alerts (alert_type,severity,source,summary,context_json) VALUES (?,?,?,?,?)",
        [value.type, value.severity ?? "error", value.source ?? "academy-api", String(value.summary).slice(0, 255), JSON.stringify(value.context ?? {})],
      );
    },
    async close() { await pool.end(); },
    async getPaymentRuntimeConfig() {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT type,description FROM settings
         WHERE type IN ('academy_asaas_environment','academy_asaas_production_webhook_sha256')
         ORDER BY id ASC`,
      );
      const values = new Map(rows.map((row) => [row.type, String(row.description ?? "").trim()]));
      const environment = values.get("academy_asaas_environment")?.toLowerCase() || null;
      const productionWebhookTokenHash = values.get("academy_asaas_production_webhook_sha256")?.toLowerCase() || null;
      if (environment && !["sandbox", "production"].includes(environment)) {
        throw new Error("The LMS payment runtime environment is invalid.");
      }
      if (productionWebhookTokenHash && !/^[a-f0-9]{64}$/.test(productionWebhookTokenHash)) {
        throw new Error("The LMS production webhook token hash is invalid.");
      }
      return { environment, productionWebhookTokenHash };
    },
    async listCatalogProducts({ activeOnly = true } = {}) {
      await ensureSchema();
      const [rows] = await pool.query(`SELECT c.slug,CONCAT('lms-course-',c.id) AS sourceTag,c.title,COALESCE(c.short_description,'') AS description,CAST(c.category_id AS CHAR) AS categoryId,'course' AS kind,'#00D9A3' AS accent,NULL AS cohort,NULL AS year,ROUND(c.price*100) AS officialPriceCents,ROUND((CASE WHEN c.discount_flag=1 THEN c.discounted_price ELSE c.price END)*100) AS priceCents,c.is_best AS featured,(c.status='active') AS active,c.id AS sortOrder,CONCAT('https://academy4u.com.br/public/',TRIM(LEADING '/' FROM c.thumbnail)) AS imageUrl,CONCAT('https://academy4u.com.br/public/',TRIM(LEADING '/' FROM c.thumbnail)) AS image600Url,c.title AS imageAlt,JSON_ARRAY(c.slug) AS keywordsJson,c.availability_status AS availability,(c.status='active' AND c.availability_status='available') AS purchasable FROM courses c ${activeOnly ? "WHERE c.status='active'" : ""} ORDER BY c.is_best DESC,c.id ASC,c.title ASC`);
      return rows.map((row) => ({ ...row, officialPriceCents: Number(row.officialPriceCents), priceCents: Number(row.priceCents), featured: Boolean(row.featured), active: Boolean(row.active), purchasable: Boolean(row.purchasable), keywords: fromJson(row.keywordsJson, []) }));
    },
    async authenticateCheckoutToken(rawToken) {
      await ensureSchema();
      const match = /^(\d+)\|([A-Za-z0-9]+)$/.exec(String(rawToken ?? "").trim());
      if (!match) return null;
      const tokenHash = crypto.createHash("sha256").update(match[2]).digest("hex");
      const [[row]] = await pool.query(
        `SELECT id,tokenable_id,abilities,expires_at FROM personal_access_tokens
         WHERE id=? AND token=? AND tokenable_type='App\\\\Models\\\\User'
           AND (expires_at IS NULL OR expires_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR)) LIMIT 1`,
        [match[1], tokenHash],
      );
      // Laravel stores this timezone-less DATETIME in America/Sao_Paulo. Use
      // an explicit UTC-03 comparison so the Node/MySQL UTC session cannot
      // make a newly issued token appear three hours old.
      if (!row) return null;
      const abilities = fromJson(row.abilities, []);
      if (!Array.isArray(abilities) || !abilities.includes("asaas:checkout")) return null;
      const [[user]] = await pool.query("SELECT id FROM users WHERE id=? AND status=1 LIMIT 1", [row.tokenable_id]);
      if (!user) return null;
      await pool.query("UPDATE personal_access_tokens SET last_used_at=NOW() WHERE id=?", [row.id]);
      return { kind: "sanctum", tokenId: Number(row.id), userId: Number(user.id) };
    },
    async revokeCheckoutToken(tokenId) {
      await ensureSchema();
      await pool.query("DELETE FROM personal_access_tokens WHERE id=?", [tokenId]);
    },
    async createLmsCheckoutQuote({ userId, recipientUserId, courseIds, couponCode }) {
      await ensureSchema();
      const ids = [...new Set((Array.isArray(courseIds) ? courseIds : []).map(Number))];
      if (!ids.length || ids.length > 20 || ids.some((value) => !Number.isSafeInteger(value) || value < 1)) {
        throw new Error("invalid_lms_cart");
      }
      const targetId = Number(recipientUserId);
      if (!Number.isSafeInteger(targetId) || targetId < 1) throw new Error("invalid_lms_recipient");
      const [[recipient]] = await pool.query("SELECT id FROM users WHERE id=? AND status=1", [targetId]);
      if (!recipient) throw new Error("invalid_lms_recipient");
      const [courses] = await pool.query(
        `SELECT id,slug,title,price,discounted_price,discount_flag FROM courses
         WHERE id IN (?) AND status='active' AND availability_status='available' AND is_paid=1`,
        [ids],
      );
      if (courses.length !== ids.length) throw new Error("invalid_lms_cart");
      const [enrolled] = await pool.query(
        `SELECT course_id FROM enrollments WHERE user_id=? AND course_id IN (?)
         AND (expiry_date IS NULL OR expiry_date>UNIX_TIMESTAMP())`,
        [targetId, ids],
      );
      if (enrolled.length) throw new Error("already_enrolled");
      let coupon = null;
      const normalizedCoupon = String(couponCode ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (normalizedCoupon) {
        [[coupon]] = await pool.query(
          "SELECT code,discount FROM coupons WHERE UPPER(code)=? AND status=1 AND CAST(expiry AS UNSIGNED)>UNIX_TIMESTAMP() LIMIT 1",
          [normalizedCoupon],
        );
        if (!coupon) throw new Error("invalid_coupon");
      }
      const raw = courses.map((course) => {
        const value = Number(course.discount_flag) === 1 ? Number(course.discounted_price) : Number(course.price);
        const basePriceCents = Math.round(value * 100);
        return { course, basePriceCents };
      });
      const subtotalCents = raw.reduce((sum, line) => sum + line.basePriceCents, 0);
      const discountCents = coupon ? Math.round(subtotalCents * Number(coupon.discount) / 100) : 0;
      let allocated = 0;
      const lines = raw.map((line, index) => {
        const lineDiscount = index === raw.length - 1
          ? discountCents - allocated
          : Math.floor(discountCents * line.basePriceCents / subtotalCents);
        allocated += lineDiscount;
        return {
          product: { slug: line.course.slug, title: line.course.title, courseId: Number(line.course.id) },
          basePriceCents: line.basePriceCents,
          discountCents: lineDiscount,
          finalPriceCents: line.basePriceCents - lineDiscount,
        };
      });
      return {
        lms: true,
        recipientUserId: targetId,
        couponCode: coupon?.code ?? null,
        subtotalCents,
        discountCents,
        totalCents: subtotalCents - discountCents,
        lines,
      };
    },
    async listCoupons() { await ensureSchema(); const [rows] = await pool.query("SELECT c.*, (SELECT COUNT(*) FROM academy_coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM academy_coupons c ORDER BY c.code"); return rows.map(coupon); },
    async getCoupon(code) { await ensureSchema(); const [[row]] = await pool.query("SELECT c.*, (SELECT COUNT(*) FROM academy_coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM academy_coupons c WHERE code=?", [code]); return coupon(row); },
    async saveCoupon(value) { await ensureSchema(); const existing = await this.getCoupon(value.code); const next = { id: existing?.id ?? id(), ...value }; await pool.query("INSERT INTO academy_coupons (id,code,discount_bps,active,starts_at,ends_at,max_redemptions,product_scope_json) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE discount_bps=VALUES(discount_bps),active=VALUES(active),starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),max_redemptions=VALUES(max_redemptions),product_scope_json=VALUES(product_scope_json)", [next.id,next.code,next.discountBps,next.active?1:0,next.startsAt,next.endsAt,next.maxRedemptions,asJson(next.productSlugs)]); return this.getCoupon(next.code); },
    async getEligibleCoupon(code, slugs) { const c = await this.getCoupon(code); if (!c || !c.active || (c.startsAt && +new Date(c.startsAt)>Date.now()) || (c.endsAt && +new Date(c.endsAt)<=Date.now()) || (c.maxRedemptions!==null && c.redemptions>=c.maxRedemptions) || (c.productSlugs.length && !slugs.every((slug)=>c.productSlugs.includes(slug)))) return null; return c; },
    async beginCheckoutAttempt(key, fingerprint) { await ensureSchema(); try { await pool.query("INSERT INTO academy_checkout_attempts (idempotency_key,fingerprint,state,expires_at) VALUES (?,?,'pending',DATE_ADD(NOW(3), INTERVAL 10 YEAR))", [key,fingerprint]); return { kind:"new" }; } catch (error) { if (error?.code !== "ER_DUP_ENTRY") throw error; const [[row]] = await pool.query("SELECT fingerprint,state,response_json AS response,expires_at FROM academy_checkout_attempts WHERE idempotency_key=?", [key]); if (!row) return this.beginCheckoutAttempt(key,fingerprint); if(row.state==='complete'&&+new Date(row.expires_at)<=Date.now()){await pool.query("DELETE FROM academy_checkout_attempts WHERE idempotency_key=? AND state='complete' AND expires_at<=NOW(3)",[key]);return this.beginCheckoutAttempt(key,fingerprint);} if (row.fingerprint !== fingerprint) return { kind:"conflict" }; const replay=fromJson(row.response,null); return row.state === "complete" && replay ? { kind:"replay", response:replay } : { kind:"pending" }; } },
    async completeCheckoutAttempt(key, response) { await ensureSchema(); await pool.query("UPDATE academy_checkout_attempts SET state='complete',response_json=?,expires_at=DATE_ADD(NOW(3), INTERVAL 24 HOUR) WHERE idempotency_key=?", [JSON.stringify(response),key]); },
    async abandonCheckoutAttempt(key) { await ensureSchema(); await pool.query("DELETE FROM academy_checkout_attempts WHERE idempotency_key=? AND state='pending'",[key]); },
    async reserveCoupon(code, attemptKey, slugs = []) { await ensureSchema(); const connection=await pool.getConnection(); try { await connection.beginTransaction(); await connection.query("DELETE FROM academy_coupon_reservations WHERE expires_at<=NOW(3)"); const [[row]]=await connection.query("SELECT c.*, (SELECT COUNT(*) FROM academy_coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM academy_coupons c WHERE c.code=? FOR UPDATE",[code]); const c=coupon(row); if(!c||!c.active||(c.startsAt&&+new Date(c.startsAt)>Date.now())||(c.endsAt&&+new Date(c.endsAt)<=Date.now())||(c.productSlugs.length&&!slugs.every((slug)=>c.productSlugs.includes(slug)))){await connection.rollback();return null;} const [[reserved]]=await connection.query("SELECT COUNT(*) total FROM academy_coupon_reservations WHERE coupon_code=? AND expires_at>NOW(3)",[code]); if(c.maxRedemptions!==null&&c.redemptions+Number(reserved.total)>=c.maxRedemptions){await connection.rollback();return null;} await connection.query("INSERT INTO academy_coupon_reservations (attempt_key,coupon_code,expires_at) VALUES (?,?,DATE_ADD(NOW(3), INTERVAL 24 HOUR))",[attemptKey,code]); await connection.commit();return c;}catch(error){await connection.rollback();throw error;}finally{connection.release();} },
    async releaseCouponReservation(attemptKey) { await ensureSchema(); await pool.query("DELETE FROM academy_coupon_reservations WHERE attempt_key=?",[attemptKey]); },
    async createOrder(order) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[existing]] = await connection.query(
          `SELECT id,status,coupon_redeemed FROM academy_orders
           WHERE provider=? AND (provider_order_id=? OR (? IS NOT NULL AND provider_group_id=?))
           ORDER BY provider_order_id=? DESC,created_at ASC LIMIT 1 FOR UPDATE`,
          [
            order.provider,
            order.providerOrderId,
            order.providerGroupId ?? null,
            order.providerGroupId ?? null,
            order.providerOrderId,
          ],
        );
        const orderId = existing?.id ?? id();
        const status = resolveOrderStatus(existing?.status, order.status);
        if (existing) {
          await connection.query(
            "UPDATE academy_orders SET provider_order_id=?,provider_group_id=?,status=?,buyer_email=?,buyer_cpf=?,buyer_name=?,buyer_phone=?,buyer_birth_date=?,buyer_address_json=?,lms_buyer_user_id=?,lms_recipient_user_id=?,payment_method=?,installments=?,installment_cents=?,subtotal_cents=?,discount_cents=?,total_cents=?,coupon_code=?,coupon_redeemed=? WHERE id=?",
            [order.providerOrderId, order.providerGroupId ?? null, status, order.buyerEmail, order.buyerCpf ?? null, order.buyerName ?? null, order.buyerPhone ?? null, order.buyerBirthDate ?? null, order.buyerAddress ? JSON.stringify(order.buyerAddress) : null, order.lmsBuyerUserId ?? null, order.lmsRecipientUserId ?? null, order.paymentMethod ?? null, order.installments ?? null, order.installmentCents ?? null, order.subtotalCents, order.discountCents, order.totalCents, order.couponCode, order.couponRedeemed ? 1 : Number(existing?.coupon_redeemed ?? 0), orderId],
          );
          await connection.query("DELETE FROM academy_order_items WHERE order_id=?", [orderId]);
        } else {
          await connection.query(
            "INSERT INTO academy_orders (id,provider,provider_order_id,provider_group_id,status,buyer_email,buyer_cpf,buyer_name,buyer_phone,buyer_birth_date,buyer_address_json,lms_buyer_user_id,lms_recipient_user_id,payment_method,installments,installment_cents,subtotal_cents,discount_cents,total_cents,coupon_code,coupon_redeemed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [orderId, order.provider, order.providerOrderId, order.providerGroupId ?? null, status, order.buyerEmail, order.buyerCpf ?? null, order.buyerName ?? null, order.buyerPhone ?? null, order.buyerBirthDate ?? null, order.buyerAddress ? JSON.stringify(order.buyerAddress) : null, order.lmsBuyerUserId ?? null, order.lmsRecipientUserId ?? null, order.paymentMethod ?? null, order.installments ?? null, order.installmentCents ?? null, order.subtotalCents, order.discountCents, order.totalCents, order.couponCode, order.couponRedeemed ? 1 : 0],
          );
        }
        for (const line of order.lines) {
          await connection.query(
            "INSERT INTO academy_order_items (order_id,course_id,course_slug,title,base_price_cents,discount_cents,final_price_cents) VALUES (?,?,?,?,?,?,?)",
            [orderId, line.product.courseId ?? null, line.product.slug, line.product.title, line.basePriceCents, line.discountCents, line.finalPriceCents],
          );
        }
        if (order.checkoutAttemptKey) {
          const [bound] = await connection.query(
            "UPDATE academy_coupon_reservations SET provider=?,provider_order_id=? WHERE attempt_key=?",
            [order.provider, order.providerOrderId, order.checkoutAttemptKey],
          );
          if (!bound.affectedRows) throw new Error("Coupon reservation is missing.");
        }
        if (status === "paid") {
          await connection.query(
            "UPDATE academy_orders SET paid_cents=total_cents,paid_installments=1,access_granted_at=COALESCE(access_granted_at,NOW(3)) WHERE id=?",
            [orderId],
          );
        }
        if (status === "paid" && order.couponCode && !existing?.coupon_redeemed) {
          await connection.query("INSERT INTO academy_coupon_redemptions (coupon_code,order_id) VALUES (?,?)", [order.couponCode, orderId]);
          await connection.query("UPDATE academy_orders SET coupon_redeemed=1 WHERE id=?", [orderId]);
          await connection.query("DELETE FROM academy_coupon_reservations WHERE attempt_key=?", [order.checkoutAttemptKey]);
        }
        await connection.commit();
        return { id: orderId, ...order, status };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async updateOrderFromWebhook({ provider, providerOrderId, providerGroupId, status, eventId }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (eventId) {
          const [seen] = await connection.query("SELECT event_id FROM academy_webhook_events WHERE event_id=?", [eventId]);
          if (seen.length) {
            await connection.rollback();
            return { duplicate: true };
          }
        }
        let [[order]] = await connection.query(
          "SELECT * FROM academy_orders WHERE provider=? AND provider_order_id=? FOR UPDATE",
          [provider, providerOrderId],
        );
        if (!order && providerGroupId) {
          [[order]] = await connection.query(
            "SELECT * FROM academy_orders WHERE provider=? AND provider_group_id=? ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
            [provider, providerGroupId],
          );
        }
        const previousStatus = order?.status ?? null;
        if (!order) {
          const reconciledId = id();
          await connection.query(
            "INSERT INTO academy_orders (id,provider,provider_order_id,provider_group_id,status,buyer_email,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,?,NULL,0,0,0,NULL)",
            [reconciledId, provider, providerOrderId, providerGroupId ?? null, status],
          );
          order = {
            id: reconciledId,
            status,
            coupon_code: null,
            coupon_redeemed: 0,
            provider_order_id: providerOrderId,
          };
        }
        const nextStatus = resolveOrderStatus(order.status, status);
        if (eventId) await connection.query("INSERT INTO academy_webhook_events (event_id) VALUES (?)", [eventId]);
        await connection.query(
          `UPDATE academy_orders SET status=?,
           paid_cents=CASE WHEN ?='paid' THEN total_cents ELSE paid_cents END,
           paid_installments=CASE WHEN ?='paid' THEN 1 ELSE paid_installments END,
           access_granted_at=CASE WHEN ?='paid' THEN COALESCE(access_granted_at,NOW(3)) ELSE access_granted_at END
           WHERE id=?`,
          [nextStatus, nextStatus, nextStatus, nextStatus, order.id],
        );
        if (nextStatus === "paid" && !order.coupon_redeemed && order.coupon_code) {
          const [[reservation]] = await connection.query(
            "SELECT attempt_key FROM academy_coupon_reservations WHERE provider=? AND provider_order_id=? FOR UPDATE",
            [provider, order.provider_order_id],
          );
          if (!reservation) throw new Error("Paid order has no coupon reservation.");
          await connection.query("INSERT INTO academy_coupon_redemptions (coupon_code,order_id) VALUES (?,?)", [order.coupon_code, order.id]);
          await connection.query("UPDATE academy_orders SET coupon_redeemed=1 WHERE id=?", [order.id]);
          await connection.query("DELETE FROM academy_coupon_reservations WHERE attempt_key=?", [reservation.attempt_key]);
        }
        if (["failed", "refunded", "chargeback"].includes(nextStatus)) {
          await connection.query(
            "DELETE FROM academy_coupon_reservations WHERE provider=? AND provider_order_id=?",
            [provider, order.provider_order_id],
          );
        }
        await connection.commit();
        return { id: order.id, status: nextStatus, previousStatus };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async replacePaymentInstallments(orderId, providerGroupId, rows) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[order]] = await connection.query(
          "SELECT * FROM academy_orders WHERE id=? AND provider='asaas' AND provider_group_id=? FOR UPDATE",
          [orderId, providerGroupId],
        );
        if (!order) throw new Error("Installment order was not found.");
        await connection.query("DELETE FROM academy_payment_installments WHERE order_id=?", [orderId]);
        for (const row of rows) {
          await connection.query(
            `INSERT INTO academy_payment_installments
             (id,order_id,provider,provider_payment_id,provider_group_id,installment_number,status,due_date,amount_cents,payment_url,paid_at)
             VALUES (?,?,'asaas',?,?,?,?,?,?,?,?)`,
            [
              id(),
              orderId,
              row.providerPaymentId,
              providerGroupId,
              row.number,
              row.status,
              row.dueDate,
              row.amountCents,
              row.paymentUrl,
              row.paidAt,
            ],
          );
        }
        const result = await reconcileInstallmentOrder(connection, order);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async listPaymentInstallments(orderId) {
      await ensureSchema();
      const [rows] = await pool.query(
        "SELECT * FROM academy_payment_installments WHERE order_id=? ORDER BY installment_number",
        [orderId],
      );
      return rows.map(paymentInstallment);
    },
    async updatePaymentInstallmentFromWebhook({
      provider,
      providerOrderId,
      providerGroupId,
      installment,
      eventId,
    }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (eventId) {
          const [created] = await connection.query(
            "INSERT IGNORE INTO academy_webhook_events (event_id) VALUES (?)",
            [eventId],
          );
          if (!created.affectedRows) {
            await connection.rollback();
            return { duplicate: true };
          }
        }
        let [[order]] = await connection.query(
          `SELECT * FROM academy_orders
           WHERE provider=? AND (provider_order_id=? OR provider_group_id=?)
           ORDER BY provider_order_id=? DESC,created_at ASC LIMIT 1 FOR UPDATE`,
          [provider, providerOrderId, providerGroupId, providerOrderId],
        );
        if (!order) {
          const reconciledId = id();
          await connection.query(
            `INSERT INTO academy_orders
             (id,provider,provider_order_id,provider_group_id,status,buyer_email,subtotal_cents,discount_cents,total_cents)
             VALUES (?,?,?,?,?,NULL,0,0,0)`,
            [reconciledId, provider, providerOrderId, providerGroupId, "processing"],
          );
          [[order]] = await connection.query(
            "SELECT * FROM academy_orders WHERE id=? FOR UPDATE",
            [reconciledId],
          );
        }
        await connection.query(
          `INSERT INTO academy_payment_installments
           (id,order_id,provider,provider_payment_id,provider_group_id,installment_number,status,due_date,amount_cents,payment_url,paid_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE order_id=VALUES(order_id),provider_group_id=VALUES(provider_group_id),
           installment_number=VALUES(installment_number),status=VALUES(status),due_date=VALUES(due_date),
           amount_cents=VALUES(amount_cents),payment_url=VALUES(payment_url),paid_at=VALUES(paid_at)`,
          [
            id(),
            order.id,
            provider,
            installment.providerPaymentId,
            providerGroupId,
            installment.number,
            installment.status,
            installment.dueDate,
            installment.amountCents,
            installment.paymentUrl,
            installment.paidAt,
          ],
        );
        await recordInstallmentReceipts(connection, order, installment);
        await reverseInstallmentReceipts(connection, order, installment);
        const result = await reconcileInstallmentOrder(connection, order);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async listOrders({ limit = 50, status } = {}) {
      await ensureSchema();
      const [rows] = await pool.query(`SELECT o.id,o.provider,o.provider_order_id AS providerOrderId,o.buyer_email AS buyerEmail,
        o.status,o.payment_method AS paymentMethod,o.installments,o.paid_installments AS paidInstallments,
        o.subtotal_cents AS subtotalCents,o.discount_cents AS discountCents,
        o.paid_cents AS paidCents,
        o.total_cents AS totalCents,o.coupon_code AS couponCode,
        (SELECT COUNT(*) FROM academy_order_items i WHERE i.order_id=o.id) items,
        o.created_at AS createdAt,o.updated_at AS updatedAt
        FROM academy_orders o ${status ? "WHERE o.status=?" : ""} ORDER BY o.updated_at DESC LIMIT ?`, status ? [status, limit] : [limit]);
      return rows.map((row) => ({
        ...row,
        subtotalCents: Number(row.subtotalCents),
        discountCents: Number(row.discountCents),
        totalCents: Number(row.totalCents),
        paidCents: Number(row.paidCents),
        installments: row.installments === null ? null : Number(row.installments),
        paidInstallments: Number(row.paidInstallments),
        items: Number(row.items),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }));
    },
    async grantOrderAccess(orderId) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[order]] = await connection.query(
          `SELECT * FROM academy_orders WHERE id=? FOR UPDATE`,
          [orderId],
        );
        if (!order || !order.lms_recipient_user_id || !order.access_granted_at) {
          await connection.rollback();
          return { granted: false, deliveries: 0 };
        }
        const [items] = await connection.query(
          "SELECT * FROM academy_order_items WHERE order_id=? ORDER BY id FOR UPDATE",
          [orderId],
        );
        let deliveries = 0;
        for (const item of items) {
          if (!item.course_id) throw new Error("Paid LMS order has an unmapped course.");
          const [[existingDelivery]] = await connection.query(
            "SELECT id FROM academy_order_deliveries WHERE order_id=? AND order_item_id=?",
            [orderId, item.id],
          );
          if (existingDelivery) continue;
          const [[course]] = await connection.query(
            `SELECT c.id,c.user_id,c.expiry_period,u.role creator_role FROM courses c
             LEFT JOIN users u ON u.id=c.user_id WHERE c.id=? LIMIT 1`,
            [item.course_id],
          );
          if (!course) throw new Error("Paid LMS course no longer exists.");
          const nowUnix = Math.floor(Date.now() / 1000);
          let paymentHistoryId = null;
          if (order.payment_method !== "pix_installment") {
            const amountValue = Number(item.final_price_cents) / 100;
            const { adminRevenue, instructorRevenue } = await revenueSplit(connection, course, amountValue);
            const [historyResult] = await connection.query(
              `INSERT INTO payment_histories
               (user_id,course_id,payment_type,amount,invoice,date_added,last_modified,admin_revenue,instructor_revenue,tax,instructor_payment_status,transaction_id,session_id,coupon,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
              [order.lms_buyer_user_id ?? order.lms_recipient_user_id, course.id, "asaas", amountValue, `ACADEMY4U-${order.id}-${item.id}`.slice(0, 255), nowUnix, nowUnix, adminRevenue, instructorRevenue, 0, 0, order.provider_order_id, order.id, order.coupon_code],
            );
            paymentHistoryId = historyResult.insertId;
          }
          const [[existingEnrollment]] = await connection.query(
            `SELECT id FROM enrollments WHERE user_id=? AND course_id=?
             AND (expiry_date IS NULL OR expiry_date>UNIX_TIMESTAMP()) ORDER BY id DESC LIMIT 1`,
            [order.lms_recipient_user_id, course.id],
          );
          let enrollmentId = existingEnrollment?.id ?? null;
          let enrollmentCreated = false;
          if (!enrollmentId) {
            const expiryDate = Number(course.expiry_period) > 0
              ? nowUnix + Number(course.expiry_period) * 30 * 86400
              : null;
            const [enrollmentResult] = await connection.query(
              `INSERT INTO enrollments (user_id,course_id,enrollment_type,entry_date,expiry_date,created_at,updated_at)
               VALUES (?,?,'paid',?,?,NOW(),NOW())`,
              [order.lms_recipient_user_id, course.id, nowUnix, expiryDate],
            );
            enrollmentId = enrollmentResult.insertId;
            enrollmentCreated = true;
          }
          await connection.query(
            `INSERT INTO academy_order_deliveries
             (order_id,order_item_id,user_id,course_id,enrollment_id,enrollment_created,payment_history_id)
             VALUES (?,?,?,?,?,?,?)`,
            [order.id, item.id, order.lms_recipient_user_id, course.id, enrollmentId, enrollmentCreated ? 1 : 0, paymentHistoryId],
          );
          if (order.lms_buyer_user_id) {
            await connection.query("DELETE FROM cart_items WHERE user_id=? AND course_id=?", [order.lms_buyer_user_id, course.id]);
          }
          deliveries += 1;
        }
        await connection.commit();
        return { granted: true, deliveries };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async revokeOrderAccess(orderId, reason = "refunded") {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[order]] = await connection.query("SELECT * FROM academy_orders WHERE id=? FOR UPDATE", [orderId]);
        if (!order) {
          await connection.rollback();
          return { revoked: false, deliveries: 0 };
        }
        const [deliveries] = await connection.query(
          `SELECT d.*,i.final_price_cents FROM academy_order_deliveries d
           JOIN academy_order_items i ON i.id=d.order_item_id
           WHERE d.order_id=? AND d.revoked_at IS NULL FOR UPDATE`,
          [orderId],
        );
        let revoked = 0;
        const nowUnix = Math.floor(Date.now() / 1000);
        for (const delivery of deliveries) {
          if (delivery.enrollment_created && delivery.enrollment_id) {
            const [[alternateEntitlement]] = await connection.query(
              `SELECT d.id FROM academy_order_deliveries d
               JOIN academy_orders o ON o.id=d.order_id
               WHERE d.order_id<>? AND d.user_id=? AND d.course_id=? AND d.revoked_at IS NULL
               AND o.access_granted_at IS NOT NULL AND o.status IN ('paid','partially_paid')
               LIMIT 1 FOR UPDATE`,
              [order.id, delivery.user_id, delivery.course_id],
            );
            if (!alternateEntitlement) {
              await connection.query(
                "DELETE FROM enrollments WHERE id=? AND user_id=? AND course_id=?",
                [delivery.enrollment_id, delivery.user_id, delivery.course_id],
              );
            }
          }
          let refundPaymentHistoryId = null;
          if (order.payment_method !== "pix_installment") {
            const amountValue = Number(delivery.final_price_cents) / -100;
            const [refundResult] = await connection.query(
              `INSERT INTO payment_histories
               (user_id,course_id,payment_type,amount,invoice,date_added,last_modified,admin_revenue,instructor_revenue,tax,instructor_payment_status,transaction_id,session_id,coupon,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
              [order.lms_buyer_user_id ?? delivery.user_id, delivery.course_id, `asaas_${reason}`.slice(0, 255), amountValue, `ACADEMY4U-REV-${order.id}-${delivery.order_item_id}`.slice(0, 255), nowUnix, nowUnix, amountValue, 0, 0, 0, `${order.provider_order_id}:${reason}`.slice(0, 255), order.id, order.coupon_code],
            );
            refundPaymentHistoryId = refundResult.insertId;
          }
          await connection.query(
            "UPDATE academy_order_deliveries SET revoked_at=NOW(3),refund_payment_history_id=? WHERE id=?",
            [refundPaymentHistoryId, delivery.id],
          );
          revoked += 1;
        }
        await connection.commit();
        return { revoked: revoked > 0, deliveries: revoked };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async getOrderWithItems(orderId) {
      await ensureSchema();
      const [[order]] = await pool.query("SELECT id,buyer_email,buyer_cpf,buyer_name,buyer_phone,buyer_birth_date,buyer_address_json FROM academy_orders WHERE id=?", [orderId]);
      if (!order) return null;
      const [items] = await pool.query("SELECT id,course_id,course_slug,title FROM academy_order_items WHERE order_id=? ORDER BY id", [orderId]);
      return {
        id: order.id,
        buyerEmail: order.buyer_email,
        buyerCpf: order.buyer_cpf,
        buyerName: order.buyer_name,
        buyerPhone: order.buyer_phone ?? null,
        buyerBirthDate: order.buyer_birth_date ?? null,
        buyerAddress: fromJson(order.buyer_address_json, null),
        items: items.map((item) => ({ id: item.id, courseId: item.course_id ? Number(item.course_id) : null, courseSlug: item.course_slug, title: item.title })),
      };
    },
    async getOrderByProviderOrderId(provider, providerOrderId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT id,provider,provider_order_id AS providerOrderId,provider_group_id AS providerGroupId,status,payment_method AS paymentMethod,
         installments,installment_cents AS installmentCents,total_cents AS totalCents
         FROM academy_orders WHERE provider=? AND provider_order_id=? LIMIT 1`,
        [provider, providerOrderId],
      );
      return row ? {
        ...row,
        installments: Number(row.installments ?? 0),
        installmentCents: row.installmentCents === null ? null : Number(row.installmentCents),
        totalCents: Number(row.totalCents),
      } : null;
    },
  };
}
