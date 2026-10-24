import { syntheticAction, syntheticPayment, addSyntheticOrderProof } from "./helpers/payment-profiles.mjs";
import { createHash } from "node:crypto";
import { createGalaticFinancialGate } from "../src/services/galatic-financial-gate.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createApp } from "./helpers/payment-profiles.mjs";
import { createInMemoryStore } from "../src/store/in-memory-store.js";
import { getEnvironment } from "../src/config/environment.js";
import { galaticPostcode } from "../src/domain/galatic-address.js";
import { shouldApplyTracking } from "../src/domain/galatic-tracking.js";
import { normalizeEnviaStatus } from "../src/services/galatic-fulfillment.js";
import { createGalaticFulfillmentService } from "./helpers/payment-profiles.mjs";
import { createGalaticPaymentRecovery } from "./helpers/payment-profiles.mjs";
import { createGalaticNotificationOutbox } from "../src/services/galatic-notification-outbox.js";
import { createAsaasClient } from "../src/integrations/asaas/client.js";
import { createGalaticNotifications } from "../src/integrations/email/galatic-notifications.js";
import { createGalaticPaymentMaintenance } from "./helpers/payment-profiles.mjs";

const orderId = "52c02ff3-b755-4df5-90ba-20ea8c8bd035";
const orderInput = { items: [{ sku: "TEST01", quantity: 1 }],
  buyer: { firstName: "Synthetic", lastName: "Buyer", email: "guest@example.test", phone: "11999999999", documentNumber: "52998224725",
    address: { postCode: "01001000", street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP" } },
  shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" }, payment: { method: "pix" } };
const source = { GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
  ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_synthetic", ASAAS_SANDBOX_WEBHOOK_TOKEN: "synthetic-webhook" };

async function listen(t, runtime) {
  const server = runtime.app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("Galatic opening gate requires deliberate production enablement and preserves post-sale endpoints", async (t) => {
  assert.equal(getEnvironment({ NODE_ENV: "production", ASAAS_ENABLED: "true", ASAAS_SANDBOX: "synthetic" }).galaticSalesEnabled, false);
  assert.equal(getEnvironment({ NODE_ENV: "production", GALATIC_SALES_ENABLED: "true" }).galaticSalesEnabled, true);
  const store = { ...createInMemoryStore(), getOrderByPublicId: async () => ({ id: orderId, status: "paid" }) };
  const runtime = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ...source, GALATIC_SALES_ENABLED: "false" }, { stores: { galatic: store }, asaasClient: {} });
  await runtime.ready; const base = await listen(t, runtime);
  const status = await (await fetch(`${base}/v1/galatic/checkout/status`)).json();
  assert.equal(status.enabled, false); assert.equal(status.salesEnabled, false); assert.equal(status.reason, "store_not_open");
  const rejected = await fetch(`${base}/v1/galatic/checkout/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(rejected.status, 503); assert.equal((await rejected.json()).error, "store_not_open");
  assert.equal((await fetch(`${base}/v1/galatic/checkout/orders/${orderId}`)).status, 200);
});

for (const failedTenant of ["academy4u", "galatic"]) test(`a failed ${failedTenant} database cannot disable the other tenant`, async (t) => {
  const stores = { academy4u: createInMemoryStore(), galatic: createInMemoryStore() };
  stores[failedTenant].ensureSchema = async () => { throw new Error("synthetic_database_down"); };
  const runtime = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", PAYMENT_TENANTS: "academy4u,galatic", NODE_ENV: "development",
    ACADEMY4U_PUBLIC_ORIGIN: "https://academy4u.com.br", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" }, { stores });
  await assert.rejects(runtime.ready);
  assert.equal(runtime.contexts.get(failedTenant).readiness.status, "error");
  const healthy = failedTenant === "galatic" ? "academy4u" : "galatic";
  assert.equal(runtime.contexts.get(healthy).readiness.status, "ready");
  const base = await listen(t, runtime);
  const route = healthy === "galatic" ? "/v1/galatic/checkout/status" : "/v1/platforms/academy4u/checkout/status";
  assert.equal((await fetch(`${base}${route}`)).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 503);
});

test("missing Galatic production encryption key fails only its readiness before schema or writes", async () => {
  const galatic = createInMemoryStore(); let schemaCalls = 0;
  galatic.ensureSchema = async () => { schemaCalls += 1; };
  const runtime = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", NODE_ENV: "production", PAYMENT_TENANTS: "academy4u,galatic",
    ACADEMY4U_PUBLIC_ORIGIN: "https://academy4u.com.br", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
    ACADEMY4U_MYSQL_URL: "mysql://synthetic-academy", GALATIC_MYSQL_URL: "mysql://synthetic-galatic" },
    { stores: { academy4u: createInMemoryStore(), galatic } });
  await assert.rejects(runtime.ready, /ENCRYPTION_KEY/);
  assert.equal(schemaCalls, 0); assert.equal(runtime.contexts.get("academy4u").readiness.status, "ready");
});

for (const failure of ["timeout", "attach", "complete", "invalid_response"]) test(`payment ${failure} preserves reservation and key, and never repeats the external POST`, async (t) => {
  let creates = 0; let releases = 0; let operation = null; let current = null;
  const state = { response: null };
  const store = { ensureSchema: async () => {}, close: async () => {},
    prepareOrder: async () => operation ? (state.response ? { kind: "replay", response: state.response } : { kind: "pending", orderId })
      : { kind: "created", order: { id: orderId, subtotalCents: 10000, shippingCents: 2500, totalCents: 12500 } },
    beginPaymentCreation: async (key, _id, details) => { operation = { key, state: "creating", pricing: details.pricing, providerCustomerId: details.customerId,
      order: { id: orderId, subtotalCents: 10000, shippingCents: 2500, totalCents: 12500, method: "pix", installments: 1 } }; },
    attachPayment: async () => { if (failure === "attach") throw new Error("synthetic_attach_failure"); current = { status: "open" }; operation.state = "attached"; },
    completeCheckoutAttempt: async (_key, response) => { if (failure === "complete") throw new Error("synthetic_response_write_failure"); state.response = response; },
    markPaymentCreationUncertain: async () => { if (operation.state === "creating") operation.state = "uncertain"; },
    releaseFailedOrder: async () => { releases += 1; },
    getOrderByPublicId: async () => current,
    getCheckoutRecovery: async () => operation,
    getCheckoutAttemptResult: async () => operation ? ({ orderId, fingerprint: createHash("sha256").update(JSON.stringify(orderInput)).digest("hex"), response: state.response }) : null,
  };
  const client = { findCustomersByDocument: async () => ({ data: [{ id: "cus_synthetic" }] }),
    createPayment: async (payload) => { creates += 1; if (failure === "timeout") throw Object.assign(new Error("timeout"), { code: "asaas_timeout" });
      return { ...payload, id: "pay_synthetic", value: failure === "invalid_response" ? 1 : payload.value, status: "PENDING" }; },
    findPaymentsByExternalReference: async () => ({ data: [] }), updatePayment: async () => {}, getPixQrCode: async () => ({}) };
  const runtime = createApp(source, { stores: { galatic: store }, asaasClient: client });
  const base = await listen(t, runtime); const key = randomUUID();
  const post = () => fetch(`${base}/v1/galatic/checkout/orders`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(orderInput) });
  assert.equal((await post()).status, 202);
  assert.equal((await post()).status, 202);
  assert.equal((await fetch(`${base}/v1/galatic/checkout/attempts/${key}`)).status, 202);
  assert.equal(creates, 1); assert.equal(releases, 0);
  assert.ok(["creating", "uncertain", "attached"].includes(operation.state));
});

test("recovery distinguishes zero, one, conflicting and installment-group results without creating a payment", async () => {
  const operation = { key: randomUUID(), state: "uncertain", providerCustomerId: "cus_synthetic",
    order: { id: orderId, method: "pix", installments: 1, subtotalCents: 10000, shippingCents: 2500, totalCents: 12500 },
    pricing: { baseCents: 12500, totalCents: 12500, installmentCents: 12500, feeCents: 0 } };
  let result = { data: [], hasMore: false }; let attached = 0; let completed = 0;
  const store = { updateOrderFromWebhook: async () => {}, getCheckoutRecovery: async () => structuredClone(operation), attachPayment: async () => { attached += 1; },
    getOrderByPublicId: async () => ({ status: "paid" }), completeCheckoutAttempt: async () => { completed += 1; } };
  const recover = createGalaticPaymentRecovery({ financialGate: createGalaticFinancialGate({ enabled: true }), store, asaasClient: { findPaymentsByExternalReference: async () => result,
    createPayment: async () => assert.fail("reconciliation must never create"), getPixQrCode: async () => ({}) } });
  await assert.rejects(() => recover({ key: operation.key }), { code: "payment_not_yet_found" });
  const payment = { id: "pay_synthetic", customer: "cus_synthetic", billingType: "PIX", externalReference: `galatic:${orderId}`, value: 125, status: "CONFIRMED" };
  for (const data of [[{ ...payment, value: 1 }], [{ ...payment, customer: "cus_foreign" }], [payment, { ...payment, id: "pay_duplicate" }]]) {
    result = { data, hasMore: false }; await assert.rejects(() => recover({ key: operation.key }), { code: "payment_reconciliation_conflict" });
  }
  result = { data: [payment], hasMore: false }; assert.equal((await recover({ key: operation.key })).body.status, "paid");
  assert.equal(attached, 1); assert.equal(completed, 1);
  operation.order.method = "credit_card"; operation.order.installments = 2; operation.pricing.installmentCents = 6250;
  result = { data: [1, 2].map((number) => ({ ...payment, id: `pay_valid_${number}`, billingType: "CREDIT_CARD", installment: "ins_synthetic", installmentNumber: number, value: 62.5 })), hasMore: false };
  assert.equal((await recover({ key: operation.key })).body.installments, 2);
  assert.equal(attached, 3); assert.equal(completed, 2);
});

test("canonical checkout CEP reaches the real label boundary and invalid addresses fail before claim", async () => {
  for (const alias of ["postCode", "postalCode", "postal_code", "cep"]) assert.equal(galaticPostcode({ [alias]: "01001-000" }), "01001000");
  assert.throws(() => galaticPostcode({ postCode: "01001000", postalCode: "99999999" }), { code: "shipping_destination_mismatch" });
  let claimed = 0; let sent = null; let address = orderInput.buyer.address;
  const store = { shipmentForOrder: async () => null, shipmentCreationContext: async () => ({ id: orderId, payment_status: "paid", service_code: "correios:pac",
    shipping_address: address, items: [{ title: "Synthetic", quantity: 1, unit_amount_cents: 10000, weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 }] }),
    claimShipmentCreation: async () => { claimed += 1; return { claimed: true }; }, saveShipment: async () => ({}), completeShipmentCreation: async () => {} };
  const snapshot = syntheticAction({ id: orderId, totalCents: 10000 });
  const originalContext = store.shipmentCreationContext;
  store.shipmentCreationContext = async () => ({ ...(await originalContext()), payment_profile_id: snapshot.profileId, payment_provider: "asaas",
    payment_provider_order_id: snapshot.providerOrderId, payment_provider_group_id: null, total_cents: snapshot.totalCents });
  const asaasClient = addSyntheticOrderProof(store, snapshot);
  const fulfillment = createGalaticFulfillmentService({ asaasClient, financialGate: createGalaticFinancialGate({ enabled: true }), store, environment: { galaticShippingOrigin: { ...orderInput.buyer.address, postalCode: "01001000" } },
    enviaClient: { ready: true, generateLabel: async (payload) => { sent = payload; return { data: [{ trackingNumber: "SYNTHETIC" }] }; } } });
  await fulfillment.createLabel(orderId); assert.equal(sent.destination.postalCode, "01001000");
  address = { ...address, postCode: "" };
  await assert.rejects(() => fulfillment.createLabel(orderId), { code: "invalid_shipping_address" });
  assert.equal(claimed, 1);
});

test("unknown carrier values cannot accidentally become delivered; terminal tracking does not regress", () => {
  assert.equal(normalizeEnviaStatus("not_delivered"), "delivery_exception");
  assert.equal(normalizeEnviaStatus("a_new_unmapped_status"), "unknown");
  assert.equal(shouldApplyTracking("delivered", "in_transit"), false);
  assert.equal(shouldApplyTracking("in_transit", "unknown"), false);
  assert.equal(shouldApplyTracking("out_for_delivery", "in_transit"), false);
});

test("durable notification worker acknowledges success and schedules failed delivery again", async () => {
  const completed = []; const failed = [];
  const run = createGalaticNotificationOutbox({ store: { claimNotificationJobs: async () => [
    { key: "ok", orderId, method: "sendPaymentConfirmed", lease: "lease1" }, { key: "retry", orderId, method: "sendPaymentReversed", lease: "lease2" }],
    getOrderNotification: async () => ({ orderId, email: "synthetic@example.test" }), completeNotificationJob: async (...args) => completed.push(args),
    failNotificationJob: async (...args) => failed.push(args) }, notifications: { ready: true,
    sendPaymentConfirmed: async () => {}, sendPaymentReversed: async () => { throw Object.assign(new Error("synthetic"), { code: "temporary" }); } } });
  assert.deepEqual(await run(), { sent: 1, failed: 1 });
  assert.deepEqual(completed, [["ok", "lease1"]]); assert.deepEqual(failed, [["retry", "lease2", "temporary"]]);
});

test("full installment refund uses the documented group endpoint with no partial value", async () => {
  const calls = [];
  const client = createAsaasClient({ asaasAvailable: true, asaasApiOrigin: "https://example.test/v3", asaasApiKey: "synthetic" }, async (url, options) => {
    calls.push({ url, method: options.method, body: options.body }); return new Response("{}", { status: 200 });
  });
  await client.refundInstallment("ins_full_group");
  assert.deepEqual(calls, [{ url: "https://example.test/v3/installments/ins_full_group/refund", method: "POST", body: undefined }]);
});

test("refund reconciliation waits for every group installment and never reissues the refund", async () => {
  let paymentStatuses = ["REFUNDED", "CONFIRMED"]; const transitions = [];
  const snapshot = syntheticAction({ id: orderId, providerOrderId: "pay_owned_1", providerGroupId: "ins_group", installments: 2, version: 1, providerReference: "ins_group" });
  const maintenance = createGalaticPaymentMaintenance({ financialGate: createGalaticFinancialGate({ enabled: true }), environment: { galaticPaymentMaintenanceEnabled: true,
    galaticPixReservationMinutes: 60, galaticCardReservationMinutes: 4320 },
    store: { listExpiredPaymentReservations: async () => [], claimRefundReconciliations: async () => [snapshot],
      recordRefundReconciliationError: async () => {}, updateOrderFromWebhook: async (value) => transitions.push(value) },
    asaasClient: { getPayment: async () => syntheticPayment(snapshot, paymentStatuses[0]), listInstallmentPayments: async () => ({ hasMore: false, totalCount: 2, data: paymentStatuses.map((status,i) => syntheticPayment(snapshot, status, i+1)) }),
      refundInstallment: async () => assert.fail("reconciliation must not repeat refund") } });
  await maintenance.run(); assert.equal(transitions.length, 0);
  paymentStatuses = ["REFUNDED", "REFUNDED"];
  await maintenance.run(); assert.equal(transitions.length, 1); assert.equal(transitions[0].status, "refunded");
});

test("email footer identifies the brand and preopening without the closed CNPJ", () => {
  const source = { GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", GALATIC_MAIL_API_TOKEN: "synthetic", GALATIC_MAIL_API_MAILBOX_ID: "synthetic-mailbox" };
  const html = createGalaticNotifications(source).previewCustom({ subject: "Synthetic", message: "Synthetic" });
  assert.match(html, /galatic\.com\.br/); assert.match(html, /prepara/);
  assert.doesNotMatch(html, /67\.956\.916\/0001-90|CNPJ/);
  const open = createGalaticNotifications({ ...source, GALATIC_SALES_ENABLED: "true" }).previewCustom({ subject: "Synthetic", message: "Synthetic" });
  assert.doesNotMatch(open, /Operação em preparação/);
});
