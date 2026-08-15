// Teste de carga local: valida que UM processo atende Academy4U + Galatic em
// paralelo sem sobrecarregar — o semáforo do cliente Asaas limita a 8 chamadas
// simultâneas (com fila limitada e falha rápida) e a camada HTTP responde sem
// 5xx mesmo sob rajada. Executa sem banco e sem rede: stores e fetch são falsos.
// Uso: node scripts/stress-tenants.mjs
import assert from "node:assert/strict";
import { createApp } from "../src/application.js";
import { createAsaasClient } from "../src/integrations/asaas/client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- parte A --
// Semáforo do cliente Asaas: nunca mais de 8 chamadas simultâneas ao provedor.
async function testProviderSemaphore() {
  let active = 0;
  let maxActive = 0;
  const slowFetch = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(60);
    active -= 1;
    return { ok: true, json: async () => ({ id: "pay_x" }) };
  };
  const client = createAsaasClient(
    { asaasAvailable: true, asaasApiOrigin: "http://asaas.fake", asaasApiKey: "$aact_test" },
    slowFetch,
  );
  const results = await Promise.allSettled(
    Array.from({ length: 60 }, (_, i) => client.getPayment(`pay_${i}`)),
  );
  assert.ok(results.every((r) => r.status === "fulfilled"), "todas as leituras devem concluir");
  assert.ok(maxActive <= 8, `concorrência máxima ${maxActive} excedeu o semáforo (8)`);

  // Rajada muito acima da capacidade: o excesso falha rápido (asaas_overloaded)
  // em vez de enfileirar para sempre e derrubar o processo.
  const burst = await Promise.allSettled(
    Array.from({ length: 300 }, (_, i) => client.getPayment(`pay_burst_${i}`)),
  );
  const rejected = burst.filter((r) => r.status === "rejected");
  assert.ok(rejected.length > 0, "rajada além da capacidade deve falhar rápido");
  assert.ok(
    rejected.every((r) => r.reason?.code === "asaas_overloaded"),
    "rejeições devem ser asaas_overloaded",
  );
  assert.ok(maxActive <= 8, `concorrência na rajada ${maxActive} excedeu o semáforo (8)`);
  console.log(`A. semáforo Asaas OK — pico de concorrência: ${maxActive}/8, ` +
    `rajada de 300: ${burst.length - rejected.length} atendidas, ${rejected.length} rejeitadas rápido`);
}

// ---------------------------------------------------------------- parte B --
// Carga HTTP nos dois tenants ao mesmo tempo, num único processo.
function fakeAcademyStore() {
  return {
    ensureSchema: async () => {},
    listCatalogProducts: async () => [],
    close: async () => {},
  };
}
function fakeGalaticStore() {
  return {
    ensureSchema: async () => {},
    close: async () => {},
    getOrderByPublicId: async () => null,
  };
}

async function testHttpLoad() {
  const { app } = createApp({
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "academy4u,galatic",
    ACADEMY4U_PUBLIC_ORIGIN: "https://academy4u.com.br",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
  }, {
    asaasClient: { verifyCredentials: async () => {} },
    stores: { academy4u: fakeAcademyStore(), galatic: fakeGalaticStore() },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Endpoints sem rate limit, misturados entre os dois tenants.
    const targets = [
      `${base}/health`,
      `${base}/health/academy4u`,
      `${base}/health/galatic`,
      `${base}/v1/platforms/academy4u/checkout/status`,
      `${base}/v1/platforms/academy4u/public/products`,
      `${base}/v1/galatic/checkout/status`,
    ];
    const TOTAL = 600; // 100 rajadas de 6 (uma por endpoint), tudo em paralelo
    // Rajada sintética pode exceder o backlog TCP (511) do loopback: uma
    // recusa de conexão aqui é limite do SO de teste, não da aplicação.
    const fetchRetry = async (url) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const r = await fetch(url);
          return { status: r.status, url };
        } catch (error) {
          if (error?.cause?.code !== "ECONNREFUSED" || attempt >= 5) throw error;
          await sleep(25);
        }
      }
    };
    const startedAt = performance.now();
    const responses = await Promise.all(
      Array.from({ length: TOTAL }, (_, i) => fetchRetry(targets[i % targets.length])),
    );
    const elapsedMs = performance.now() - startedAt;

    const byStatus = new Map();
    for (const r of responses) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const serverErrors = responses.filter((r) => r.status >= 500);
    assert.equal(serverErrors.length, 0, `houve ${serverErrors.length} respostas 5xx sob carga`);
    assert.ok(
      responses.every((r) => r.status === 200),
      `status inesperados: ${JSON.stringify([...byStatus])}`,
    );
    console.log(`B. carga HTTP OK — ${TOTAL} requisições paralelas (2 tenants) em ` +
      `${elapsedMs.toFixed(0)}ms, todas 200, nenhum 5xx`);

    // Rate limiting sob rajada: mesma origem estoura o limite de leitura com
    // 429 (proteção), nunca com 500. Usa a rota Galatic (limite 60/min) que
    // consulta apenas o store — pedido inexistente responde 404.
    const limited = await Promise.all(
      Array.from({ length: 90 }, () => fetch(`${base}/v1/galatic/checkout/orders/pedido-inexistente`)),
    );
    const codes = new Map();
    for (const r of limited) codes.set(r.status, (codes.get(r.status) ?? 0) + 1);
    assert.ok(!limited.some((r) => r.status >= 500), "rate limit não pode virar 5xx");
    assert.ok(limited.some((r) => r.status === 429), "rajada acima do limite deve responder 429");
    console.log(`C. rate limit OK — 90 leituras em rajada: ${JSON.stringify([...codes])} (429 = proteção ativa, 0 5xx)`);

    // Processo continua saudável depois do estresse.
    const finalHealth = await fetch(`${base}/health`);
    assert.equal(finalHealth.status, 200, "processo deve seguir saudável após o estresse");
    console.log("D. processo saudável após o estresse — /health 200");
  } finally {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

await testProviderSemaphore();
await testHttpLoad();
console.log("\nStress OK: um processo atende os dois tenants em paralelo sem sobrecarregar.");
