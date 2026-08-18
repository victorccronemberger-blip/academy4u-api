import mysql from "mysql2/promise";

const { createMySqlStore } = await import("../src/store/mysql-store.js");
const store = createMySqlStore(process.env.MYSQL_URL);
await store.ensureSchema();

const u = new URL(process.env.MYSQL_URL);
const c = await mysql.createConnection({
  host: u.hostname, port: Number(u.port || 3306),
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  database: decodeURIComponent(u.pathname.replace(/^\//, "")), timezone: "Z", dateStrings: true,
});

const [orders] = await c.query("SELECT id FROM academy_orders ORDER BY id DESC LIMIT 1");
const orderId = String(orders[0].id);
const email = `store-debug-${Date.now()}@example.invalid`;
const nextRetryAt = new Date(Date.now() - 30_000).toISOString();
console.log("ISO enviado:", nextRetryAt, "| orderId:", orderId);

const created = await store.recordArtActivation({
  orderId, orderItemId: 96, courseId: 1738, lmsUserId: 0, artEmail: email,
  artTag: "cfp-2026_54", status: "existing_account_no_access", retryCount: 0, nextRetryAt,
});
console.log("recordArtActivation:", created);

const [raw] = await c.query(
  "SELECT id,status,retry_count,next_retry_at, (next_retry_at<=NOW(3)) AS due FROM academy_art_activations WHERE art_email=?",
  [email],
);
console.log("Linha via store:", JSON.stringify(raw));

const pending = await store.listArtActivationsPendingRetry({ limit: 50, maxRetries: 8 });
console.log("listPending via store retorna:", pending.map((r) => ({ id: r.id, email: r.artEmail, status: r.status })));

await c.query("DELETE FROM academy_art_activations WHERE art_email=?", [email]);
await store.close();
await c.end();