// Valida os métodos de retry do mysql-store contra o banco real (conexão remota ativa).
// Uso: MYSQL_URL='mysql://user:pass@host:3306/db' node scripts/check-art-retry-store.mjs
import mysql from "mysql2/promise";

const dsn = process.env.MYSQL_URL;
if (!dsn) {
  console.error("MYSQL_URL ausente. Ex.: MYSQL_URL='mysql://user:pass@host:3306/db' node scripts/check-art-retry-store.mjs");
  process.exit(1);
}

const url = new URL(dsn);
const connection = await mysql.createConnection({ ...mysqlHelpers(url), timezone: "Z", dateStrings: true });

function mysqlHelpers(u) {
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

const { createMySqlStore } = await import("../src/store/mysql-store.js");
const store = createMySqlStore(dsn);

try {
  await store.ensureSchema();
  console.log("Conectado ao MySQL real (schema ok).");

  // 1. Colunas de academy_art_activations (retry_count / next_retry_at).
  const [cols] = await connection.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'academy_art_activations'",
    [url.pathname.replace(/^\//, "")],
  );
  const names = cols.map((row) => row.COLUMN_NAME);
  console.log("Colunas academy_art_activations:", names.join(", "));
  for (const required of ["retry_count", "next_retry_at"]) {
    if (!names.includes(required)) {
      console.error(`FALTA coluna ${required} — rodar ALTER TABLE.`);
      process.exitCode = 1;
    }
  }

  // 2. Ciclo record -> listPending -> update. academy_art_activations.order_id tem
  // FK para academy_orders.id (ON DELETE CASCADE), então usa uma order real existente.
  const [orderRows] = await connection.query("SELECT id FROM academy_orders ORDER BY id DESC LIMIT 1");
  if (!orderRows.length) {
    console.error("Nenhuma academy_orders disponível para testar. VALIDAÇÃO INCONCLUSIVA.");
    process.exitCode = 2;
  } else {
    const orderId = String(orderRows[0].id); // academy_orders.id é UUID (string), não inteiro.
    const fake = {
      orderId,
      orderItemId: 1,
      courseId: 1738,
      lmsUserId: 0,
      artEmail: `retry-check-${Date.now()}@example.invalid`,
      artTag: "cfp-2026_54",
      status: "existing_account_no_access",
      retryCount: 0,
      // -30s: robusto contra skew de relógio host↔MySQL (~1s observado). Em
      // produção o serviço agenda +15min, então o desvio é irrelevante.
      nextRetryAt: new Date(Date.now() - 30_000).toISOString(),
    };
    const created = await store.recordArtActivation(fake);
    console.log("recordArtActivation:", created);

    const pending = await store.listArtActivationsPendingRetry({ limit: 50, maxRetries: 8 });
    console.log("pending retornados:", pending.map((row) => ({ id: row.id, orderId: row.orderId, artEmail: row.artEmail, status: row.status })));
    const found = pending.find((row) => row.orderId === orderId && row.artEmail === fake.artEmail);
    console.log("listArtActivationsPendingRetry encontrou:", found ? { id: found.id, retryCount: found.retryCount } : "NAO");

    if (found) {
      const updated = await store.updateArtActivationRetry(found.id, {
        status: "activated",
        retryCount: 1,
        nextRetryAt: null,
        result: { ok: true, checkedAt: new Date().toISOString() },
      });
      console.log("updateArtActivationRetry:", updated);
      const after = await store.listArtActivations({ limit: 50 });
      const row = after.find((entry) => entry.id === found.id);
      console.log("Estado final:", row ? { id: row.id, status: row.status, retryCount: row.retryCount, nextRetryAt: row.nextRetryAt } : "NAO");
      if (row?.status !== "activated" || row.retryCount !== 1) process.exitCode = 1;
    } else {
      process.exitCode = 1;
    }
    // Limpeza do registro fake.
    await connection.query("DELETE FROM academy_art_activations WHERE art_email LIKE 'retry-check-%@example.invalid'");
    console.log("Registro fake removido. VALIDAÇÃO ", process.exitCode ? "COM ERRO" : "OK.");
  }
} finally {
  await store.close();
  await connection.end();
}