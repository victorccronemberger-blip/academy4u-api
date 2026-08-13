#!/usr/bin/env node
/**
 * list-products.mjs — Lista os produtos ATIVOS do catálogo (tabela products).
 * Mostra slug, sourceTag, cohort (turma), preço e status — para escolher qual
 * curso "de venda" testar.
 *
 * Uso:
 *   MYSQL_URL='mysql://user:pass@host:3306/db' node scripts/list-products.mjs
 */
import mysql from "mysql2/promise";

const url = new URL(process.env.MYSQL_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
});

try {
  const [cols] = await conn.query("SHOW COLUMNS FROM academy_products");
  console.log("colunas da tabela academy_products:", cols.map((c) => c.Field).join(", "));

  const [rows] = await conn.query("SELECT * FROM academy_products");
  console.log(`\ntotal produtos: ${rows.length}`);

  const active = rows.filter((p) => p.active !== 0 && p.active !== false);
  console.log(`\n=== PRODUTOS ATIVOS (${active.length}) ===`);
  for (const p of active) {
    const cohort = p.cohort ?? p.cohortTurma ?? p.cohort_id ?? "";
    console.log(`- ${String(p.slug).padEnd(34)} | source_tag=${String(p.source_tag ?? p.sourceTag ?? "").padEnd(20)} | cohort=${String(cohort).padEnd(6)} | price=${p.price_cents ?? p.priceCents}`);
  }

  console.log("\n=== TODOS (com inativos) ===");
  for (const p of rows) {
    const activeFlag = p.active === 0 || p.active === false ? "INATIVO" : "ativo  ";
    const cohort = p.cohort ?? p.cohortTurma ?? p.cohort_id ?? "";
    console.log(`- [${activeFlag}] ${String(p.slug).padEnd(34)} | source_tag=${String(p.source_tag ?? p.sourceTag ?? "").padEnd(20)} | cohort=${String(cohort).padEnd(6)} | price=${p.price_cents ?? p.priceCents}`);
  }
} finally {
  await conn.end();
}
