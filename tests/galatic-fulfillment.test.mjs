import { createGalaticFinancialGate } from "../src/services/galatic-financial-gate.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { getEnvironment } from "../src/config/environment.js";
import { createEnviaWebhookHandler } from "../src/routes/envia-webhook.js";
import { syntheticAction, syntheticPayment, addSyntheticOrderProof, createGalaticFulfillmentService } from "./helpers/payment-profiles.mjs";

function productionLabelFixture({ installments = 1, method = "pix", legacy = false } = {}) {
  const trace = []; let stored = null; let operation = null;
  const order = { payment_profile_id: "galatic-synthetic", id: "20d42dfd-9bf6-44f3-932b-625b475e324a", payment_status: "paid", payment_provider: "asaas",
    payment_provider_order_id: "pay_synthetic_1", payment_provider_group_id: installments > 1 ? "ins_synthetic" : null,
    payment_method: method, installments, total_cents: 12000, buyer_name: "Synthetic Buyer", buyer_email: "buyer@example.test",
    buyer_phone: "11999999999", buyer_document: "52998224725", service_code: "correios:pac",
    shipping_address: { street: "Rua B", number: "2", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
    items: [{ title: "Jogo", quantity: 1, unit_amount_cents: 12000, weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 }] };
  const payments = Array.from({ length: installments }, (_, index) => ({ id: `pay_synthetic_${index + 1}`,
    customer: "cus_synthetic", billingType: method === "pix" ? "PIX" : "CREDIT_CARD", value: 120 / installments,
    externalReference: `galatic:${order.id}`, status: "CONFIRMED",
    ...(installments > 1 ? { installment: "ins_synthetic", installmentNumber: index + 1 } : {}) }));
  const fixture = { order, payments, trace, result: { data: payments, hasMore: false, totalCount: installments },
    recovery: legacy ? null : { profileId: "galatic-synthetic", state: "completed", providerCustomerId: "cus_synthetic", pricing: { totalCents: 12000 },
      order: { profileId: "galatic-synthetic", providerOrderId: order.payment_provider_order_id, providerGroupId: order.payment_provider_group_id, id: order.id, method, installments, totalCents: 12000 } }, existing: null };
  const store = { shipmentForOrder: async () => fixture.existing || stored,
    shipmentCreationContext: async () => order,
    getCheckoutRecovery: async ({ orderId }) => { assert.equal(orderId, order.id); trace.push("checkout-read"); return fixture.recovery; },
    claimShipmentCreation: async () => { trace.push("claim"); return operation ? { claimed: false, status: operation }
      : ((operation = "in_progress"), { claimed: true }); },
    completeShipmentCreation: async () => { trace.push("complete"); operation = "completed"; },
    markShipmentCreationUncertain: async () => { trace.push("uncertain"); operation = "needs_reconciliation"; },
    saveShipment: async (_orderId, value) => (trace.push("save"), stored = { order_id: order.id, tracking_code: value.trackingCode }) };
  const asaasClient = { getPayment: async (id) => { trace.push("payment-read"); assert.equal(id, order.payment_provider_order_id); return fixture.linked ?? payments[0]; },
    listInstallmentPayments: async (reference) => { trace.push("group-read"); assert.equal(reference, order.payment_provider_group_id); return fixture.result; } };
  const enviaClient = { ready: true, generateLabel: async () => { trace.push("envia"); return { data: [{ trackingNumber: "BR-SYNTHETIC" }] }; } };
  const environment = { galaticEnviaEnvironment: "production", asaasEnvironment: "production", asaasApiOrigin: "https://api.asaas.com/v3",
    galaticShippingOrigin: { name: "Galatic", street: "Rua A", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" } };
  Object.assign(fixture, { store, asaasClient, enviaClient, environment,
    service: () => createGalaticFulfillmentService({ financialGate: createGalaticFinancialGate({ enabled: true }), environment, store, asaasClient: fixture.asaasClient, enviaClient }) });
  return fixture;
}

async function assertPaymentBlocked(fixture) {
  const before = structuredClone(fixture.order);
  await assert.rejects(() => fixture.service().createLabel(fixture.order.id), { code: "shipping_payment_unverified" });
  assert.ok(!fixture.trace.some((event) => ["claim", "envia", "save", "complete", "uncertain"].includes(event)), fixture.trace.join(", "));
  assert.deepEqual(fixture.order, before, "verification cannot flip local financial status");
}

test("locally paid orders missing in production cannot acquire an operation or emit a label", async () => {
  const fixture = productionLabelFixture({ legacy: true });
  fixture.asaasClient.getPayment = async () => { fixture.trace.push("production-404"); throw Object.assign(new Error("not_found"), { status: 404 }); };
  await assertPaymentBlocked(fixture);
  assert.deepEqual(fixture.trace, ["checkout-read"]);
});

for (const method of ["pix", "credit_card"]) test(`current matching production ${method} payment authorizes one label and reuses it`, async () => {
  const fixture = productionLabelFixture({ method }); const service = fixture.service();
  assert.equal((await service.createLabel(fixture.order.id)).created, true);
  assert.equal((await service.createLabel(fixture.order.id)).created, false);
  assert.deepEqual(fixture.trace, ["checkout-read", "payment-read", "claim", "envia", "save", "complete"]);
});

test("legacy binding absence blocks production labels without inventing a customer mapping", async () => {
  for (const recovery of [null, { state: "completed", order: { id: "20d42dfd-9bf6-44f3-932b-625b475e324a", method: "pix", installments: 1, totalCents: 12000 }, pricing: null, providerCustomerId: null }]) {
    const fixture = productionLabelFixture({ legacy: true }); fixture.recovery = recovery;
    await assertPaymentBlocked(fixture);
    assert.deepEqual(fixture.recovery, recovery);
  }
});

test("stored labels are reused even when production payment evidence and providers are unavailable", async () => {
  const fixture = productionLabelFixture(); fixture.existing = { order_id: fixture.order.id, tracking_code: "EXISTING" };
  fixture.asaasClient = null; fixture.enviaClient.ready = false; fixture.environment.galaticShippingOrigin = null;
  assert.equal((await fixture.service().createLabel(fixture.order.id)).created, false);
  assert.deepEqual(fixture.trace, []);
});

const invalidPaymentCases = {
  deleted: (f) => { f.payments[0].deleted = true; },
  refunded: (f) => { f.payments[0].status = "REFUNDED"; },
  pending: (f) => { f.payments[0].status = "PENDING"; },
  chargeback: (f) => { f.payments[0].status = "CHARGEBACK_REQUESTED"; },
  "partial refund": (f) => { f.payments[0].refundedValue = 1; },
  "refund pending": (f) => { f.payments[0].refunds = [{ status: "PENDING", value: 1 }]; },
  "wrong payment ID": (f) => { f.payments[0].id = "pay_other"; },
  "wrong external reference": (f) => { f.payments[0].externalReference = "galatic:another-order"; },
  "wrong method": (f) => { f.payments[0].billingType = "CREDIT_CARD"; },
  "wrong value": (f) => { f.payments[0].value = 1; },
  "wrong stored customer": (f) => { f.payments[0].customer = "cus_other"; },
  "missing current customer": (f) => { delete f.payments[0].customer; },
  "missing linked payment": (f) => { f.order.payment_provider_order_id = null; },
  "missing payment method": (f) => { f.order.payment_method = null; },
  "unknown payment provider": (f) => { f.order.payment_provider = "other"; },
  "missing stored binding on priced checkout": (f) => { f.recovery.providerCustomerId = null; },
  "conflicting stored pricing": (f) => { f.recovery.pricing.totalCents = 100; },
  "unexpected group for single payment": (f) => { f.payments[0].installment = "ins_other"; },
  "unavailable provider": (f) => { f.asaasClient = null; },
  timeout: (f) => { f.asaasClient.getPayment = async () => { throw Object.assign(new Error("timeout"), { code: "asaas_timeout" }); }; },
  "sandbox provider configuration": (f) => { f.environment.asaasEnvironment = "sandbox"; },
  "sandbox provider origin": (f) => { f.environment.asaasEnvironment = "sandbox"; f.environment.asaasApiOrigin = "https://api-sandbox.asaas.com/v3"; },
};
for (const [name, invalidate] of Object.entries(invalidPaymentCases)) test(`production label blocks ${name} before claim`, async () => {
  const fixture = productionLabelFixture(); invalidate(fixture); await assertPaymentBlocked(fixture);
  if (name.startsWith("sandbox provider")) assert.deepEqual(fixture.trace, []);
});

for (const installments of [2, 10]) test(`production ${installments}x card requires the complete currently paid group before claim`, async () => {
  const fixture = productionLabelFixture({ installments, method: "credit_card" });
  assert.equal((await fixture.service().createLabel(fixture.order.id)).created, true);
  assert.deepEqual(fixture.trace, ["checkout-read", "payment-read", "group-read", "claim", "envia", "save", "complete"]);
});

const invalidGroupCases = {
  "only first installment paid": (f) => { for (const payment of f.payments.slice(1)) payment.status = "PENDING"; },
  "missing installment": (f) => { f.result.data = f.payments.slice(0, -1); },
  "truncated result": (f) => { f.result.hasMore = true; },
  "unknown pagination completeness": (f) => { delete f.result.hasMore; },
  "conflicting total count": (f) => { f.result.totalCount += 1; },
  "duplicate IDs": (f) => { f.payments[1].id = f.payments[0].id; },
  "wrong group": (f) => { f.payments[1].installment = "ins_other"; },
  "wrong stored group": (f) => { f.order.payment_provider_group_id = "ins_other"; },
  "linked payment absent from group": (f) => { f.linked = { ...f.payments[0] }; f.payments[0].id = "pay_another"; },
  "foreign customer": (f) => { f.payments[1].customer = "cus_other"; },
  "foreign reference": (f) => { f.payments[1].externalReference = "galatic:other"; },
  "wrong method": (f) => { f.payments[1].billingType = "PIX"; },
  "wrong aggregate total despite plausible installment values": (f) => { for (const payment of f.payments) payment.value += 0.01; },
  "deleted installment": (f) => { f.payments[1].deleted = true; },
  "refunded installment": (f) => { f.payments[1].status = "REFUNDED"; },
  "null payment entry": (f) => { f.result.data[1] = null; },
  "group provider unavailable": (f) => { f.asaasClient.listInstallmentPayments = async () => { throw new Error("unavailable"); }; },
};
for (const [name, invalidate] of Object.entries(invalidGroupCases)) test(`production installment label blocks ${name} before claim`, async () => {
  const fixture = productionLabelFixture({ installments: 10, method: "credit_card" }); invalidate(fixture); await assertPaymentBlocked(fixture);
});

test("legacy installment evidence still requires one current customer and the complete group", async () => {
  const fixture = productionLabelFixture({ installments: 10, method: "credit_card", legacy: true });
  fixture.order.payment_provider_group_id = null;
  await assertPaymentBlocked(fixture);
  const foreign = productionLabelFixture({ installments: 10, method: "credit_card", legacy: true });
  foreign.payments[1].customer = "cus_other"; await assertPaymentBlocked(foreign);
});

test("production verification finishes before the existing claim serializes concurrent label requests", async () => {
  const fixture = productionLabelFixture({ installments: 10, method: "credit_card" });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  fixture.enviaClient.generateLabel = async () => { fixture.trace.push("envia"); await gate; return { data: [{ trackingNumber: "BR-SYNTHETIC" }] }; };
  const service = fixture.service(); const first = service.createLabel(fixture.order.id);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.createLabel(fixture.order.id), { code: "shipping_in_progress" });
  assert.deepEqual(fixture.trace, ["checkout-read", "payment-read", "group-read", "claim", "envia",
    "checkout-read", "payment-read", "group-read", "claim"]);
  release(); assert.equal((await first).created, true);
  assert.equal(fixture.trace.filter((event) => event === "envia").length, 1);
});

test("keeps Envia in sandbox unless production is explicitly selected", () => {
  const sandbox = getEnvironment({ GALATIC_ENVIA_API_KEY: "test" });
  assert.equal(sandbox.galaticEnviaEnvironment, "sandbox");
  assert.equal(sandbox.galaticEnviaApiOrigin, "https://api-test.envia.com");
  const production = getEnvironment({ GALATIC_ENVIA_API_KEY: "live", GALATIC_ENVIA_ENVIRONMENT: "production" });
  assert.equal(production.galaticEnviaApiOrigin, "https://api.envia.com");
  assert.throws(() => getEnvironment({ GALATIC_ENVIA_ENVIRONMENT: "preview" }));
});

test("creates one paid-order label and reuses it on retry", async () => {
  let stored = null; let operation = null; const providerCalls = [];
  const store = {
    shipmentForOrder: async () => stored,
    claimShipmentCreation: async (_orderId, operationId) => operation ? { claimed: false, status: operation.status }
      : ((operation = { operationId, status: "in_progress" }), { claimed: true }),
    completeShipmentCreation: async () => { operation.status = "completed"; return true; },
    markShipmentCreationUncertain: async () => { operation.status = "needs_reconciliation"; return true; },
    shipmentCreationContext: async () => ({ id: "order-1", payment_status: "paid", buyer_name: "Cliente",
      buyer_email: "cliente@example.com", buyer_phone: "11999999999", buyer_document: "52998224725",
      service_code: "correios:pac", shipping_address: { street: "Rua B", number: "2", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
      items: [{ title: "Jogo", quantity: 1, unit_amount_cents: 12000, weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 }] }),
    saveShipment: async (orderId, value) => (stored = { order_id: orderId, ...value, tracking_code: value.trackingCode,
      label_url: value.labelUrl, track_url: value.trackUrl, provider_cost_cents: value.costCents, status: "label_created", created_at: "2026-08-15" }),
  };
  const enviaClient = { ready: true, generateLabel: async (payload) => { providerCalls.push(payload); return { data: [{ shipmentId: 10,
    carrier: "correios", service: "pac", trackingNumber: "BR123", label: "https://files.envia.com/label.pdf",
    trackUrl: "https://tracking.envia.com/BR123", totalPrice: 25, currency: "BRL" }] }; } };
  const environment = { galaticShippingOrigin: { name: "Galatic", email: "loja@example.com", phone: "11999999999", street: "Rua A",
    number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000", taxId: "11222333000181" } };
  const originalContext = store.shipmentCreationContext;
  const proofContext = await originalContext();
  const snapshot = syntheticAction({ id: proofContext.id, totalCents: 12000 });
  store.shipmentCreationContext = async () => ({ ...(await originalContext()), payment_profile_id: snapshot.profileId,
    payment_provider: "asaas", payment_provider_order_id: snapshot.providerOrderId, payment_provider_group_id: null, total_cents: snapshot.totalCents });
  const asaasClient = addSyntheticOrderProof(store, snapshot);
  const service = createGalaticFulfillmentService({ asaasClient, financialGate: createGalaticFinancialGate({ enabled: true }), environment, store, enviaClient });
  assert.equal((await service.createLabel("order-1")).created, true);
  assert.equal((await service.createLabel("order-1")).created, false);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0].shipment, { type: 1, carrier: "correios", service: "pac" });
});

test("serializes concurrent label requests before calling Envia", async () => {
  let releaseProvider; let operation = null; let providerCalls = 0; let stored = null;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const context = { id: "order-race", payment_status: "paid", buyer_name: "Cliente", buyer_email: "c@example.com",
    buyer_phone: "11999999999", buyer_document: "52998224725", service_code: "correios:pac",
    shipping_address: { street: "Rua B", number: "2", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
    items: [{ title: "Jogo", quantity: 1, unit_amount_cents: 12000, weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 }] };
  const store = {
    shipmentForOrder: async () => stored, shipmentCreationContext: async () => context,
    claimShipmentCreation: async (_orderId, operationId) => operation ? { claimed: false, status: operation.status }
      : ((operation = { operationId, status: "in_progress" }), { claimed: true }),
    completeShipmentCreation: async () => { operation.status = "completed"; return true; },
    markShipmentCreationUncertain: async () => { operation.status = "needs_reconciliation"; return true; },
    saveShipment: async (orderId, value) => (stored = { order_id: orderId, ...value, tracking_code: value.trackingCode,
      label_url: null, track_url: null, provider_cost_cents: null, status: "label_created" }),
  };
  const enviaClient = { ready: true, generateLabel: async () => { providerCalls += 1; await providerGate;
    return { data: [{ shipmentId: "shipment-1", trackingNumber: "BR-RACE" }] }; } };
  const environment = { galaticShippingOrigin: { name: "Galatic", email: "loja@example.com", phone: "11999999999",
    street: "Rua A", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000", taxId: "11222333000181" } };
  const originalContext = store.shipmentCreationContext;
  const proofContext = await originalContext();
  const snapshot = syntheticAction({ id: proofContext.id, totalCents: 12000 });
  store.shipmentCreationContext = async () => ({ ...(await originalContext()), payment_profile_id: snapshot.profileId,
    payment_provider: "asaas", payment_provider_order_id: snapshot.providerOrderId, payment_provider_group_id: null, total_cents: snapshot.totalCents });
  const asaasClient = addSyntheticOrderProof(store, snapshot);
  const service = createGalaticFulfillmentService({ asaasClient, financialGate: createGalaticFinancialGate({ enabled: true }), environment, store, enviaClient });
  const first = service.createLabel(context.id);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.createLabel(context.id), (error) => error.code === "shipping_in_progress");
  assert.equal(providerCalls, 1);
  releaseProvider();
  assert.equal((await first).created, true);
});

test("blocks blind retry when Envia result is uncertain", async () => {
  let operation = null; let calls = 0; const alerts = [];
  const store = { shipmentForOrder: async () => null, shipmentCreationContext: async () => ({ id: "order-uncertain", payment_status: "paid",
    buyer_name: "Cliente", buyer_email: "c@example.com", buyer_phone: "11999999999", buyer_document: "52998224725",
    service_code: "correios:pac", shipping_address: { street: "Rua", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
    items: [{ title: "Jogo", quantity: 1, unit_amount_cents: 1000, weight_grams: 1000, length_cm: 10, width_cm: 10, height_cm: 10 }] }),
    claimShipmentCreation: async (_id, operationId) => operation ? { claimed: false, status: operation.status }
      : ((operation = { operationId, status: "in_progress" }), { claimed: true }),
    markShipmentCreationUncertain: async () => { operation.status = "needs_reconciliation"; return true; },
    recordOperationalAlert: async (value) => alerts.push(value) };
  const enviaClient = { ready: true, generateLabel: async () => { calls += 1; throw Object.assign(new Error("timeout"), { code: "timeout" }); } };
  const environment = { galaticShippingOrigin: { name: "Galatic", street: "Rua", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" } };
  const originalContext = store.shipmentCreationContext;
  const proofContext = await originalContext();
  const snapshot = syntheticAction({ id: proofContext.id, totalCents: 12000 });
  store.shipmentCreationContext = async () => ({ ...(await originalContext()), payment_profile_id: snapshot.profileId,
    payment_provider: "asaas", payment_provider_order_id: snapshot.providerOrderId, payment_provider_group_id: null, total_cents: snapshot.totalCents });
  const asaasClient = addSyntheticOrderProof(store, snapshot);
  const service = createGalaticFulfillmentService({ asaasClient, financialGate: createGalaticFinancialGate({ enabled: true }), environment, store, enviaClient });
  await assert.rejects(() => service.createLabel("order-uncertain"), (error) => error.code === "timeout");
  await assert.rejects(() => service.createLabel("order-uncertain"), (error) => error.code === "shipping_needs_reconciliation");
  assert.equal(calls, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "shipment_reconciliation_required");
  assert.equal(alerts[0].context.orderId, "order-uncertain");
});

test("authenticates and deduplicates Envia tracking webhooks", async () => {
  const secret = "envia-webhook-secret"; const timestamp = String(Date.now()); const event = "tracking.simple";
  const body = { type: event, data: { tracking_number: "BR123", status: "delivered", status_description: "Entregue" } };
  const rawBody = JSON.stringify(body); const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${event}.${rawBody}`).digest("hex");
  const calls = []; const notifications = [];
  const handler = createEnviaWebhookHandler({ financialGate: createGalaticFinancialGate({ enabled: true }), environment: { galaticEnviaWebhookSecret: secret },
    store: { updateShipmentFromEvent: async (value) => { calls.push(value); return { updated: true, orderId: "order-1" }; },
      getOrderNotification: async () => ({ orderId: "order-1", email: "cliente@example.com", name: "Cliente" }),
      claimNotification: async () => true, releaseNotification: async () => {} },
    notifications: { sendShippingUpdate: async (value) => { notifications.push(value); } } });
  const request = { body, rawBody, get: (name) => ({ "x-webhook-timestamp": timestamp, "x-webhook-event": event,
    "x-webhook-signature": `v1=${signature}`, "x-webhook-id": "delivery-1" })[name.toLowerCase()] };
  const response = { code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
  await handler(request, response);
  assert.equal(response.code, 200); assert.equal(calls.length, 1); assert.equal(calls[0].status, "delivered");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1); assert.equal(notifications[0].status, "delivered");
});
