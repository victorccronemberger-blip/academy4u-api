import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createHmac, createHash } from "node:crypto";
import { createApp } from "../src/application.js";
import { getEnvironment } from "../src/config/environment.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";
import { createGalaticFinancialGate } from "../src/services/galatic-financial-gate.js";
import { createGalaticPaymentRecovery } from "../src/services/galatic-payment-recovery.js";
import { createGalaticPaymentMaintenance } from "../src/services/galatic-payment-maintenance.js";
import { createGalaticFulfillmentService } from "../src/services/galatic-fulfillment.js";
import { createGalaticCheckoutRouter } from "../src/routes/galatic-checkout.js";
import { createGalaticShippingRouter } from "../src/routes/galatic-shipping.js";
import { createAsaasWebhookHandler } from "../src/routes/asaas-integration.js";

const orderId = "52c02ff3-b755-4df5-90ba-20ea8c8bd035";
const token = "synthetic-owner-session-token-00000000000000";
const auth = { authorization: `Bearer ${token}` };
const source = { NODE_ENV: "production", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
  GALATIC_MYSQL_URL: "mysql://synthetic-galatic", GALATIC_DATA_ENCRYPTION_KEY: "a".repeat(64),
  GALATIC_BOT_PROTECTION_ENABLED: "false", GALATIC_SALES_ENABLED: "true", ASAAS_ENABLED: "true",
  ASAAS_ENVIRONMENT: "production", ASAAS_API_KEY: "synthetic-global-key", ASAAS_WEBHOOK_TOKEN: "synthetic-hook",
  GALATIC_ENVIA_WEBHOOK_TOKEN: "synthetic-envia", GALATIC_ENVIA_ENVIRONMENT: "production" };

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { "x-forwarded-proto": "https", ...options.headers } });
    return { status: response.status, body: await response.json() };
  };
}

async function fixture(t, overrides = {}) {
  const calls = []; const financialWrites = [];
  const forbidden = (name) => async () => { financialWrites.push(name); throw new Error(`forbidden:${name}`); };
  const store = { ...createInMemoryStore(),
    getOrderByPublicId: async () => ({ id: orderId, providerOrderId: "pay_synthetic", method: "pix", status: "open" }),
    getCheckoutAttemptResult: async () => ({ orderId, response: { body: { status: "open", pix: { emv: "must-not-expose" } } } }),
    adminForSession: async () => ({ id: "owner", role: "owner", status: "active" }),
    customerForSession: async () => ({ id: "customer", email: "synthetic@example.test" }),
    adminListOrders: async () => [{ id: orderId }], adminListProducts: async () => [],
    adminPaymentOperations: async () => [{ state: "uncertain" }],
    listCustomerOrders: async () => [{ id: orderId }],
    ...Object.fromEntries(["prepareOrder", "previewCheckout", "beginPaymentCreation", "getCheckoutRecovery", "attachPayment",
      "updateOrderFromWebhook", "updatePaymentInstallmentFromWebhook", "adminCancelUnpaidOrder", "releaseFailedOrder", "claimRefund",
      "claimPaymentReconciliations", "claimRefundReconciliations", "listExpiredPaymentReservations", "claimShipmentCreation",
      "saveShipment", "updateShipmentFromEvent", "adminManualDispatch", "adminSetShippingStatus", "createShippingQuotes"]
      .map((name) => [name, forbidden(name)])) };
  const provider = new Proxy({ ready: true }, { get(target, key) {
    if (key in target) return target[key];
    // Initialization verification remains the preexisting backend-wide contract.
    if (key === "verifyCredentials") return async () => {};
    return async () => { calls.push(String(key)); throw Object.assign(new Error("provider404"), { status: 404 }); };
  } });
  const runtime = createApp({ ...source, ...overrides }, { stores: { galatic: store }, asaasClient: provider, enviaClient: provider });
  await runtime.ready;
  return { runtime, store, calls, financialWrites, read: await serve(t, runtime.app) };
}

for (const value of [undefined, "false", "TRUE", " true", "true ", "1", true]) {
  test(`financial gate requires exact literal true: ${String(value)}`, async (t) => {
    const f = await fixture(t, { GALATIC_FINANCIAL_OPERATIONS_ENABLED: value });
    const status = await f.read("/v1/galatic/checkout/status");
    assert.equal(status.body.financialOperationsEnabled, false);
    assert.equal(status.body.enabled, false); assert.equal(status.body.reason, "financial_operations_paused");
    f.runtime.environment.galaticFinancialOperationsEnabled = true;
    f.runtime.contexts.get("galatic").environment.galaticFinancialOperationsEnabled = true;
    assert.throws(() => { f.runtime.contexts.get("galatic").financialGate.enabled = true; }, TypeError);
    const result = await f.read("/v1/galatic/checkout/installments", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(result.status, 503); assert.equal(result.body.error, "financial_operations_paused");
    assert.deepEqual(f.calls, []); assert.deepEqual(f.financialWrites, []);
  });
}

test("paused production rejects every Galatic financial route before provider I/O, reservation, claims, events or stock release", async (t) => {
  const f = await fixture(t);
  const paths = ["/v1/galatic/checkout/installments", "/v1/galatic/checkout/orders", "/v1/checkout/installments", "/v1/checkout/orders",
    "/v1/galatic/shipping", "/v1/galatic/quote",
    ...["payment/cancel", "payment/refund", "payment/reconcile", "shipping/label", "shipping/refresh", "shipping/cancel", "shipping/manual-dispatch", "shipping/manual-status"]
      .map((suffix) => `/v1/galatic/admin/orders/${orderId}/${suffix}`)];
  for (const path of paths) {
    const result = await f.read(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(result.status, 503, path); assert.equal(result.body.error, "financial_operations_paused", path);
  }
  for (const prefix of ["/v1/galatic/checkout", "/v1/checkout"]) {
    const snapshot = await f.read(`${prefix}/orders/${orderId}`);
    assert.equal(snapshot.status, 200); assert.equal(snapshot.body.status, "open"); assert.equal(snapshot.body.refreshAvailable, false);
    for (const suffix of [`/orders/${orderId}/pix`, `/attempts/${orderId}`]) {
      const result = await f.read(prefix + suffix); assert.equal(result.status, 503); assert.equal(result.body.error, "financial_operations_paused");
    }
  }
  f.store.getOrderByPublicId = async () => ({ id: orderId, providerOrderId: "pay_synthetic", method: "pix", status: "paid" });
  assert.deepEqual((await f.read(`/v1/checkout/orders/${orderId}/pix`)).body, { id: orderId, status: "paid" });
  const shipping = await f.read("/v1/galatic/shipping/status");
  assert.equal(shipping.body.enabled, false); assert.equal(shipping.body.labels, false);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.financialWrites, []);
});

test("authenticated webhooks retry while paused; invalid authentication stays unauthorized; no event is consumed", async (t) => {
  const f = await fixture(t);
  const event = { event: "PAYMENT_CONFIRMED", id: "evt_synthetic", payment: { id: "pay_synthetic", externalReference: `galatic:${orderId}`, status: "CONFIRMED" } };
  const post = (path, headers, body) => f.read(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post("/v1/webhooks/asaas", { "asaas-access-token": "invalid" }, event)).status, 401);
  assert.equal((await post("/v1/webhooks/asaas", { "asaas-access-token": "synthetic-hook" }, event)).status, 503);
  assert.equal((await post("/v1/webhooks/envia", { authorization: "Bearer invalid" }, {})).status, 401);
  assert.equal((await post("/v1/webhooks/envia", { authorization: "Bearer synthetic-envia" }, {})).status, 503);
  assert.deepEqual(f.financialWrites, []);
});

test("Envia HMAC and Asaas token hash authenticate before pause, including custom Galatic prefix", async (t) => {
  const secret = "synthetic-hmac";
  const f = await fixture(t, { GALATIC_ENVIA_WEBHOOK_SECRET: secret, GALATIC_PAYMENT_REFERENCE_PREFIX: "galaticcustom",
  });
  // Existing runtime config owns the hash; no new environment key is invented.
  f.runtime.contexts.get("galatic").environment.asaasWebhookTokenHash = createHash("sha256").update("synthetic-hash-token").digest("hex");
  const raw = JSON.stringify({ id: "evt_synthetic", data: { trackingNumber: "synthetic" } });
  const timestamp = String(Date.now()), event = "tracking";
  const signature = createHmac("sha256", secret).update(`${timestamp}.${event}.${raw}`).digest("hex");
  const result = await f.read("/v1/webhooks/envia", { method: "POST", headers: { "content-type": "application/json", "x-webhook-timestamp": timestamp,
    "x-webhook-event": event, "x-webhook-signature": signature }, body: raw });
  assert.equal(result.status, 503);
  for (const [credential, expected] of [["invalid", 401], ["synthetic-hash-token", 503]]) {
    const response = await f.read("/v1/webhooks/asaas", { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": credential },
      body: JSON.stringify({ payment: { externalReference: `galaticcustom:${orderId}` } }) });
    assert.equal(response.status, expected);
  }
  assert.deepEqual(f.financialWrites, []);
});

test("closed factories are safe when DI omits the gate; mail outbox still completes jobs", async () => {
  const calls = []; const forbidden = async () => { assert.fail("financial work must not be selected"); };
  const store = { getCheckoutRecovery: forbidden, shipmentForOrder: forbidden, claimPaymentReconciliations: forbidden,
    claimRefundReconciliations: forbidden, listExpiredPaymentReservations: forbidden,
    claimNotificationJobs: async () => [{ key: "synthetic-job", orderId, method: "sendOrderCreated", details: {}, lease: "lease" }],
    getOrderNotification: async () => ({ orderId }), completeNotificationJob: async () => calls.push("complete") };
  await assert.rejects(createGalaticPaymentRecovery({ store, asaasClient: {} })({ orderId }), { code: "financial_operations_paused" });
  const fulfillment = createGalaticFulfillmentService({ environment: {}, store, enviaClient: {} });
  for (const method of ["createLabel", "refresh", "cancel"]) await assert.rejects(fulfillment[method](orderId), { code: "financial_operations_paused" });
  const maintenance = createGalaticPaymentMaintenance({ environment: { galaticPaymentMaintenanceEnabled: true }, store, asaasClient: {},
    notifications: { ready: true, sendOrderCreated: async () => calls.push("mail") } });
  assert.equal((await maintenance.run()).skippedPayments, true); assert.deepEqual(calls, ["mail", "complete"]);
});

test("standalone checkout, shipping and Galatic webhook factories default closed even with enabled environment", async (t) => {
  const app = express(); app.use(express.json());
  const environment = { ...getEnvironment({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true" }), tenantId: "galatic", galaticSalesEnabled: true, asaasWebhookToken: "synthetic" };
  const store = { previewCheckout: async () => assert.fail("preview"), updateOrderFromWebhook: async () => assert.fail("webhook") };
  app.use("/checkout", createGalaticCheckoutRouter(express, { environment, store, asaasClient: {} }));
  app.use("/shipping", createGalaticShippingRouter(express, { environment, store, enviaClient: { ready: true } }));
  app.post("/hook", createAsaasWebhookHandler({ environment, store, referencePrefix: "custom" }));
  const read = await serve(t, app);
  for (const path of ["/checkout/installments", "/shipping", "/hook"]) {
    const response = await read(path, { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": "synthetic" }, body: "{}" });
    assert.equal(response.status, 503); assert.equal(response.body.error, "financial_operations_paused");
  }
});

test("local catalog, account and history reads remain available; diagnostics require owner and reveal only safe immutable boot fields", async (t) => {
  const f = await fixture(t);
  for (const path of ["/v1/galatic/catalog/products", "/v1/galatic/account/orders", "/v1/galatic/admin/orders", "/v1/galatic/admin/payment-operations"])
    assert.equal((await f.read(path, { headers: auth })).status, 200, path);
  assert.equal((await f.read("/v1/galatic/admin/runtime")).status, 401);
  const snapshot = await f.read("/v1/galatic/admin/runtime", { headers: auth });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(Object.keys(snapshot.body).sort(), ["releaseRevision", "sourceFingerprint", "bootId", "startedAt", "galaticFinancialOperationsEnabled", "galaticFinancialOperationsInFlight"].sort());
  assert.equal(snapshot.body.galaticFinancialOperationsEnabled, false); assert.equal(snapshot.body.galaticFinancialOperationsInFlight, 0);
  assert.deepEqual((await f.read("/v1/galatic/admin/runtime", { headers: auth })).body, snapshot.body);
  assert.doesNotMatch(JSON.stringify(snapshot.body), /synthetic-global-key|mysql|synthetic-hook|token|command/i);
  f.store.adminForSession = async () => ({ role: "staff" });
  assert.equal((await f.read("/v1/galatic/admin/runtime", { headers: auth })).status, 403);
});

test("literal true has controlled legacy behavior and tracks held pipelines through success and failure", async (t) => {
  const f = await fixture(t, { GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true" });
  const gate = f.runtime.contexts.get("galatic").financialGate;
  let release; const held = new Promise((resolve) => { release = resolve; });
  let entered; const entering = new Promise((resolve) => { entered = resolve; });
  f.store.previewCheckout = async () => { entered(); await held; throw new Error("synthetic-failure"); };
  const request = f.read("/v1/checkout/installments", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ sku: "SYNTHETIC", quantity: 1 }], shipping: { quoteId: orderId } }) });
  await entering; assert.equal(gate.diagnostics().galaticFinancialOperationsInFlight, 1);
  release(); assert.equal((await request).status, 500); assert.equal(gate.diagnostics().galaticFinancialOperationsInFlight, 0);
  assert.equal(await gate.run(async () => "success"), "success");
  await assert.rejects(gate.run(async () => { throw new Error("failure"); }), /failure/);
  assert.equal(gate.diagnostics().galaticFinancialOperationsInFlight, 0);
});

test("gate boot metadata is captured immutably and unknown metadata is reported honestly", () => {
  const metadata = { releaseRevision: "a".repeat(40), sourceFingerprint: "b".repeat(64) };
  const gate = createGalaticFinancialGate({ metadata, bootId: "synthetic-boot", clock: () => new Date("2026-10-24T00:00:00Z") });
  metadata.releaseRevision = "later";
  assert.equal(gate.diagnostics().releaseRevision, "a".repeat(40));
  assert.equal(gate.diagnostics().startedAt, "2026-10-24T00:00:00.000Z");
  const unknown = createGalaticFinancialGate().diagnostics();
  assert.equal(unknown.releaseRevision, null); assert.equal(unknown.sourceFingerprint, null);
});

test("sales closure retains store_not_open precedence during financial pause", async (t) => {
  const f = await fixture(t, { GALATIC_SALES_ENABLED: "false" });
  assert.equal((await f.read("/v1/checkout/status")).body.reason, "store_not_open");
  const result = await f.read("/v1/checkout/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(result.status, 503); assert.equal(result.body.error, "store_not_open");
});

test("Academy checkout, status, webhook and ART stay available alongside paused Galatic", async (t) => {
  const academy = createInMemoryStore(); const galatic = createInMemoryStore(); let academyWebhook = 0;
  academy.listArtMappings = async () => [{ course_id: 1 }];
  const providerCalls = [];
  const client = { findCustomersByDocument: async () => ({ data: [{ id: "cus_synthetic" }] }),
    createPayment: async (payload) => { providerCalls.push(payload.externalReference); return { ...payload, id: "pay_academy_synthetic", status: "PENDING" }; },
    updatePayment: async () => ({ id: "pay_academy_synthetic", status: "PENDING" }), getPixQrCode: async () => ({}) };
  const originalUpdate = academy.updateOrderFromWebhook;
  academy.updateOrderFromWebhook = async (input) => { academyWebhook += 1; return originalUpdate.call(academy, input); };
  const runtime = createApp({ ...source, NODE_ENV: "test", PAYMENT_TENANTS: "academy4u,galatic",
    ACADEMY4U_PUBLIC_ORIGIN: "https://academy4u.com.br", ACADEMY4U_TRUSTED_CHECKOUT_TOKEN: "synthetic-trusted" },
  { stores: { academy4u: academy, galatic }, asaasClient: client });
  await runtime.ready; const read = await serve(t, runtime.app);
  const [academyStatus, galaticStatus] = await Promise.all([read("/v1/checkout/status"), read("/v1/galatic/checkout/status")]);
  assert.equal(academyStatus.body.enabled, true); assert.equal(galaticStatus.body.enabled, false);
  const created = await read("/v1/checkout/orders", { method: "POST", headers: { "content-type": "application/json",
    "idempotency-key": "700a31bc-49f7-4c9b-bd38-caa6462b8884", "x-academy-trusted-token": "synthetic-trusted" },
    body: JSON.stringify({ slugs: ["novo-cpa"], buyer: { firstName: "Synthetic", lastName: "Buyer", email: "buyer@example.test",
      phone: "11999999999", documentNumber: "52998224725" }, payment: { method: "pix" } }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(providerCalls.length, 1); assert.match(providerCalls[0], /^academy:/);
  const event = { id: "evt_academy_synthetic", event: "PAYMENT_CONFIRMED", payment: { id: "pay_academy_synthetic", status: "CONFIRMED", externalReference: providerCalls[0] } };
  const hook = await read("/v1/webhooks/asaas", { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": "synthetic-hook" }, body: JSON.stringify(event) });
  assert.equal(hook.status, 200); assert.equal(academyWebhook, 1);
  assert.equal((await read("/v1/art/mappings", { headers: { "x-academy-trusted-token": "synthetic-trusted" } })).status, 200);
  assert.equal(runtime.contexts.get("galatic").financialGate.diagnostics().galaticFinancialOperationsInFlight, 0);
});

test("Galatic default cannot mount Academy public/ART aliases or start an Academy worker even when ART is configured", async (t) => {
  let workerStarts = 0; let retries = 0; let activations = 0;
  const runtime = createApp({ ...source, ART_ENABLED: "true", GALATIC_TRUSTED_CHECKOUT_TOKEN: "synthetic-trusted" }, {
    stores: { galatic: createInMemoryStore() }, asaasClient: {}, artClient: { ready: true },
    artRetryWorker: { start: () => { workerStarts += 1; }, processPending: async () => { retries += 1; return { processed: 1 }; } },
    artActivation: { isEnabled: () => true, activateOrder: async () => { activations += 1; } },
  });
  await runtime.ready; const read = await serve(t, runtime.app);
  const headers = { "content-type": "application/json", "x-academy-trusted-token": "synthetic-trusted" };
  assert.equal((await read("/v1/art/retry", { method: "POST", headers, body: "{}" })).status, 404);
  assert.equal((await read("/v1/art/mappings", { headers })).status, 404);
  assert.equal((await read("/v1/public/products")).status, 404);
  assert.equal((await read("/v1/public/quote", { method: "POST", headers, body: JSON.stringify({ slugs: ["novo-cpa"] }) })).status, 404);
  assert.equal(workerStarts, 0); assert.equal(retries, 0); assert.equal(activations, 0);
  assert.equal(runtime.contexts.get("galatic").artRetryWorker, undefined);
  assert.equal(runtime.contexts.get("galatic").artActivation, undefined);
  assert.equal((await read("/v1/galatic/catalog/products")).status, 200);
  assert.equal((await read("/v1/checkout/status")).body.reason, "financial_operations_paused");
});

test("Academy default still starts its configured ART worker and serves legacy public/ART aliases", async (t) => {
  let workerStarts = 0, retries = 0;
  const store = createInMemoryStore(); store.listArtMappings = async () => [];
  const runtime = createApp({ NODE_ENV: "test", ART_ENABLED: "true", TRUSTED_CHECKOUT_TOKEN: "synthetic-trusted" }, {
    store, asaasClient: {}, artClient: { ready: true },
    artRetryWorker: { start: () => { workerStarts += 1; }, processPending: async () => { retries += 1; return { processed: 1 }; } },
  });
  await runtime.ready; const read = await serve(t, runtime.app);
  const headers = { "content-type": "application/json", "x-academy-trusted-token": "synthetic-trusted" };
  assert.equal((await read("/v1/art/retry", { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal((await read("/v1/art/mappings", { headers })).status, 200);
  assert.equal((await read("/v1/public/products")).status, 200);
  const quote = await read("/v1/public/quote", { method: "POST", headers, body: JSON.stringify({ slugs: ["novo-cpa"] }) });
  assert.equal(quote.status, 200); assert.equal(quote.body.lines[0].slug, "novo-cpa");
  assert.equal(workerStarts, 1); assert.equal(retries, 1);
});
