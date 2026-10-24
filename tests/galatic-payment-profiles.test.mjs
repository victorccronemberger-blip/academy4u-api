import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";
import { createAsaasClient } from "../src/integrations/asaas/client.js";
import { createGalaticFinancialGate } from "../src/services/galatic-financial-gate.js";
import { createGalaticPaymentProfiles, profileIdentityHash, assertWalletIdentity } from "../src/services/galatic-payment-profiles.js";
import { loadGalaticPaymentProof, cancelBoundGalaticPayment } from "../src/services/galatic-payment-proof.js";
import { createGalaticPaymentMaintenance } from "../src/services/galatic-payment-maintenance.js";
import { createGalaticPaymentRecovery } from "../src/services/galatic-payment-recovery.js";
import { createGalaticFulfillmentService } from "../src/services/galatic-fulfillment.js";

const walletA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", walletB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const wallet = (id) => ({ object: "list", hasMore: false, totalCount: 1, offset: 0, limit: 10, data: [{ object: "wallet", id }] });
const caps = ["checkout", "read", "recovery", "cancel", "refund", "webhook", "fulfillment"];
const entry = (id, expectedWalletId = walletA, environment = "sandbox") => ({ id, provider: "asaas", environment, expectedWalletId,
  allowedTenants: ["galatic"], apiKeyEnv: `GALATIC_${id.toUpperCase()}_KEY`, webhookTokenEnv: `GALATIC_${id.toUpperCase()}_TOKEN` });
const entries = [entry("alpha"), entry("beta", walletB)];
function source(profiles = entries, defaultId = "alpha") {
  return { GALATIC_PAYMENT_PROFILES_JSON: JSON.stringify(profiles), GALATIC_DEFAULT_PAYMENT_PROFILE_ID: defaultId,
    ...Object.fromEntries(profiles.flatMap((p) => [[p.apiKeyEnv, `${p.id}-synthetic-key`], [p.webhookTokenEnv, `${p.id}-synthetic-hook`]])) };
}
function ledger() {
  const identities = new Map(); const authorizations = new Map(entries.map((p) => [p.id, { capabilities: caps, commercialApproved: false }]));
  return { identities, authorizations, phase: true,
    registerPaymentProfileIdentity: async (identity, hash) => {
      if (identities.has(identity.id) && identities.get(identity.id) !== hash) throw new Error("conflict");
      identities.set(identity.id, hash);
    },
    getPaymentProfileAuthorization: async (id) => authorizations.get(id) ?? { capabilities: [] },
    async assertPaymentProfileDispatchPhase() { if (!this.phase) throw Object.assign(new Error("cutover"), { code: "payment_profile_cutover_required" }); },
  };
}
async function registry({ config = source(), store = ledger(), clients = {}, enabled = true, clock = () => Date.now(), fetcher = null, legacyWebhookAuthentication = {} } = {}) {
  const calls = []; const gate = createGalaticFinancialGate({ enabled });
  const profiles = createGalaticPaymentProfiles({ source: config, store, financialGate: gate, clock, legacyWebhookAuthentication,
    createClient(snapshot, _fetch, id) {
      assert.ok(Object.isFrozen(snapshot));
      if (fetcher) return createAsaasClient(snapshot, fetcher);
      return { getWallets: async () => { calls.push([id, "wallet", snapshot.asaasApiOrigin]); return wallet(id === "alpha" ? walletA : walletB); }, ...clients[id] };
    } });
  await profiles.initialize(); return { profiles, calls, store, gate };
}
const snapshot = (profileId = "alpha", installments = 1) => ({ profileId, id: "synthetic-order", providerOrderId: "pay_shared",
  providerGroupId: installments > 1 ? "ins_shared" : null, method: installments > 1 ? "credit_card" : "pix", installments,
  totalCents: 10000, providerCustomerId: "cus_owned", pricing: { totalCents: 10000 } });
function payment(bound, status = "PENDING", index = 1) {
  return { id: index === 1 ? bound.providerOrderId : `pay_shared_${index}`, customer: bound.providerCustomerId,
    billingType: bound.method === "pix" ? "PIX" : "CREDIT_CARD", value: bound.totalCents / 100 / bound.installments,
    externalReference: `galatic:${bound.id}`, status, ...(bound.providerGroupId ? { installment: bound.providerGroupId } : {}) };
}

test("T1: failed Galatic wallet verification leaves Academy and Galatic local data healthy", async (t) => {
  const galatic = Object.assign(createInMemoryStore(), ledger());
  const runtime = createApp({ NODE_ENV: "test", PAYMENT_TENANTS: "academy4u,galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.example",
    ACADEMY4U_PUBLIC_ORIGIN: "https://academy.example", ASAAS_ENABLED: "true", ASAAS_API_KEY: "academy-synthetic",
    GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ...source() }, { stores: { galatic, academy4u: createInMemoryStore() },
    asaasClient: { getPayment: async () => assert.fail("Galatic must never use Academy") },
    createGalaticAsaasClient: () => ({ getWallets: async () => { throw new Error("synthetic-wallet-failure"); } }) });
  await runtime.ready;
  assert.equal(runtime.contexts.get("academy4u").readiness.status, "ready");
  assert.equal(runtime.contexts.get("galatic").readiness.status, "ready");
  const environment = runtime.contexts.get("galatic").environment;
  assert.equal(environment.asaasApiKey, undefined); assert.equal(environment.asaasWebhookToken, undefined);
  const server = runtime.app.listen(0, "127.0.0.1"); t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(base + "/v1/checkout/status")).json()).enabled, true);
  const status = await (await fetch(base + "/v1/galatic/checkout/status")).json();
  assert.equal(status.checkoutAvailable, false); assert.equal(status.profileStatus, "unverified");
  assert.equal((await fetch(base + "/v1/galatic/catalog/products")).status, 200);
});

test("T2: changing the default and restarting retains every bound capability on the original profile", async () => {
  const store = ledger(); const first = await registry({ store });
  const original = await first.profiles.resolveNewOrderProfile(); assert.equal(original.profileId, "alpha");
  const restarted = await registry({ store, config: source(entries, "beta") });
  assert.equal((await restarted.profiles.resolveNewOrderProfile()).profileId, "beta");
  for (const capability of caps) assert.equal((await restarted.profiles.getVerifiedClient(original, capability)).profileId, "alpha");
  await assert.rejects(() => restarted.profiles.getVerifiedClient({}, "read"), { code: "payment_profile_unknown" });
});

test("T2: every actual consumer keeps alpha after restart while new checkout, customer and pricing use beta", async (t) => {
  const durable = ledger(); const before = await registry({ store: durable });
  assert.equal((await before.profiles.resolveNewOrderProfile()).profileId, "alpha");
  const calls = []; const orders = new Map(); const oldKey = randomUUID(); let oldResponse = null; let refundState = "in_progress";
  const makeOrder = (name, status = "open") => {
    const order = { ...snapshot(), id: randomUUID(), providerOrderId: `pay_alpha_${name}`, status, subtotalCents: 10000, shippingCents: 0,
      fulfillmentStatus: "awaiting_payment" }; orders.set(order.id, order); return order;
  };
  const readOrder = makeOrder("read"), cancelOrder = makeOrder("cancel"), refundOrder = makeOrder("refund", "paid");
  const recoveryOrder = makeOrder("recovery"), workerOrder = makeOrder("worker"), labelOrder = makeOrder("label", "paid");
  const states = new Map([...orders.values()].map((order) => [order.id, order.status === "paid" ? "CONFIRMED" : "PENDING"]));
  const store = Object.assign(createInMemoryStore(), durable, {
    getOrderByPublicId: async (id) => orders.has(id) ? { ...orders.get(id) } : null,
    getCheckoutRecovery: async ({ key, orderId }) => { const order = key === oldKey ? recoveryOrder : orders.get(orderId); return order ? {
      profileId: order.profileId, key: key ?? oldKey, state: "uncertain", order: { ...order }, pricing: order.pricing, providerCustomerId: order.providerCustomerId } : null; },
    updateOrderFromWebhook: async (input) => { const order = [...orders.values()].find((o) => o.profileId === input.profileId && o.providerOrderId === input.providerOrderId);
      if (order) order.status = input.status; return { id: order?.id, status: order?.status }; },
    getCheckoutAttemptResult: async (key) => key === oldKey ? { profileId: "alpha", fingerprint: bodyFingerprint, orderId: recoveryOrder.id, response: oldResponse } : null,
    completeCheckoutAttempt: async (key, result) => { if (key === oldKey) oldResponse = result; },
    attachPayment: async (id, _ref, status, details) => { assert.equal(details.profileId, orders.get(id).profileId); orders.get(id).status = status; },
    adminForSession: async () => ({ id: "synthetic-owner", role: "owner", status: "active" }),
    adminPaymentContext: async (id) => orders.get(id),
    claimRefund: async (id) => ({ ...orders.get(id), claimed: true, providerReference: orders.get(id).providerOrderId, referenceKind: "payment", group: false, version: 1 }),
    finishRefundRequest: async (_id, state) => { refundState = state; return { updated: true }; },
    adminRefundOperation: async () => ({ state: refundState, attempt_version: 1, error_code: null, authorization_required: false, authorization_source: null }),
    claimBoundAction: async ({ orderId }) => ({ ...orders.get(orderId), claimed: true, providerReference: orders.get(orderId).providerOrderId, referenceKind: "payment", group: false, version: 1 }),
    finishCancellationRequest: async () => {},
    adminCancelUnpaidOrder: async (id, proof) => { assert.equal(proof.profileId, orders.get(id).profileId); orders.get(id).status = "canceled"; return true; },
    listExpiredPaymentReservations: async () => [workerOrder],
    recordOperationalAlert: async () => {},
    claimExternalOperation: async ({ profileId }) => { assert.equal(profileId, "beta"); calls.push(["beta", "claim-customer"]); return "claim"; },
    finishExternalOperation: async () => {},
    prepareOrder: async (input) => { assert.equal(input.profileId, "beta"); calls.push(["beta", "reserve"]);
      const order = { ...snapshot("beta", 2), id: randomUUID(), providerOrderId: "pay_beta_new", providerGroupId: "ins_beta_new", providerCustomerId: "cus_beta",
        status: "pending", subtotalCents: 10000, shippingCents: 0, totalCents: 10000 }; orders.set(order.id, order); return { kind: "created", order }; },
    beginPaymentCreation: async (_key, id, details) => { assert.equal(details.profileId, "beta"); assert.equal(details.customerId, "cus_beta"); orders.get(id).pricing = details.pricing; },
    shipmentForOrder: async () => null,
    shipmentCreationContext: async () => ({ id: labelOrder.id, payment_profile_id: "alpha", payment_provider: "asaas", payment_status: "paid",
      payment_provider_order_id: labelOrder.providerOrderId, payment_provider_group_id: null, payment_method: "pix", installments: 1, total_cents: 10000,
      service_code: "correios:pac", shipping_address: { street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
      items: [{ title: "Synthetic", quantity: 1, unit_amount_cents: 10000, weight_grams: 1000, length_cm: 10, width_cm: 10, height_cm: 10 }] }),
    claimShipmentCreation: async () => ({ claimed: true }), completeShipmentCreation: async () => {},
    saveShipment: async () => ({ order_id: labelOrder.id }),
  });
  const alpha = {
    getPayment: async (id) => { calls.push(["alpha", "read", id]); const order = [...orders.values()].find((o) => o.providerOrderId === id); assert.equal(order.profileId, "alpha"); return payment(order, states.get(order.id)); },
    findPaymentsByExternalReference: async (reference) => { calls.push(["alpha", "recover"]); const order = orders.get(reference.slice(8)); return { hasMore: false, totalCount: 1, data: [payment(order, states.get(order.id))] }; },
    getPixQrCode: async () => (calls.push(["alpha", "pix"]), { encodedImage: "synthetic", payload: "synthetic-pix" }),
    deletePayment: async () => (calls.push(["alpha", "delete"]), { deleted: true }),
    refundPayment: async (id) => (calls.push(["alpha", "refund"]), { id }),
    createCustomer: async () => assert.fail("old profile must not create new customers"), createPayment: async () => assert.fail("old profile must not charge again"),
  };
  const beta = { findCustomersByDocument: async () => (calls.push(["beta", "customer-lookup"]), { data: [] }),
    createCustomer: async () => (calls.push(["beta", "customer"]), { id: "cus_beta" }),
    simulatePayment: async () => (calls.push(["beta", "pricing"]), { creditCard: { feePercentage: 3, operationFee: 0 } }),
    createPayment: async (payload) => (calls.push(["beta", "payment"]), { ...payload, id: "pay_beta_new", installment: "ins_beta_new", value: payload.totalValue / 2, status: "PENDING" }),
    getPayment: async () => assert.fail("historical reads must not use the new default") };
  const after = await registry({ store, config: source(entries, "beta"), clients: { alpha, beta } });
  const runtime = createApp({ NODE_ENV: "test", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.example",
    GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", GALATIC_SALES_ENABLED: "true" }, { stores: { galatic: store }, galaticPaymentProfiles: after.profiles,
    asaasClient: new Proxy({}, { get: () => () => assert.fail("legacy fallback") }) });
  await runtime.ready; const server = runtime.app.listen(0, "127.0.0.1"); t.after(() => server.close()); await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { items: [{ sku: "SYNTHETIC", quantity: 1 }], buyer: { firstName: "Synthetic", lastName: "Buyer", email: "synthetic@example.test", phone: "11999999999", documentNumber: "52998224725",
    address: { postalCode: "01001000", street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP" } }, shipping: { quoteId: randomUUID() },
    payment: { method: "credit_card", installments: 2, card: { holderName: "Synthetic Buyer", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" } } };
  const oldBody = { ...body, payment: { method: "pix" } };
  const bodyFingerprint = createHash("sha256").update(JSON.stringify(oldBody)).digest("hex");
  assert.equal((await fetch(`${base}/v1/checkout/orders/${readOrder.id}`)).status, 200);
  assert.equal((await fetch(`${base}/v1/checkout/orders/${readOrder.id}/pix`)).status, 200);
  await createGalaticPaymentRecovery({ store, paymentProfiles: after.profiles, financialGate: after.gate })({ key: oldKey });
  const headers = { "content-type": "application/json", authorization: "Bearer synthetic-owner-token-000000000000000000" };
  assert.equal((await fetch(`${base}/v1/galatic/admin/orders/${cancelOrder.id}/payment/cancel`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal((await fetch(`${base}/v1/galatic/admin/orders/${refundOrder.id}/payment/refund`, { method: "POST", headers, body: JSON.stringify({ confirmation: refundOrder.id }) })).status, 202);
  const worker = createGalaticPaymentMaintenance({ store, paymentProfiles: after.profiles, financialGate: after.gate,
    environment: { galaticPaymentMaintenanceEnabled: true, galaticPixReservationMinutes: 1, galaticCardReservationMinutes: 1 } });
  assert.equal((await worker.run()).canceled, 1);
  const fulfillment = createGalaticFulfillmentService({ store, paymentProfiles: after.profiles, financialGate: after.gate,
    environment: { galaticEnviaEnvironment: "sandbox", galaticShippingOrigin: { street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" } },
    enviaClient: { ready: true, generateLabel: async () => (calls.push(["alpha", "label-after-proof"]), { data: [{ trackingNumber: "SYNTHETIC" }] }) } });
  assert.equal((await fulfillment.createLabel(labelOrder.id)).created, true);
  const replay = await fetch(`${base}/v1/checkout/orders`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": oldKey }, body: JSON.stringify(oldBody) });
  assert.equal((await replay.json()).orderId, recoveryOrder.id);
  const created = await fetch(`${base}/v1/checkout/orders`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(body) });
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  for (const operation of ["read", "pix", "recover", "delete", "refund", "label-after-proof"]) assert.ok(calls.some(([id, op]) => id === "alpha" && op === operation), operation);
  for (const operation of ["reserve", "claim-customer", "customer", "pricing", "payment"]) assert.ok(calls.some(([id, op]) => id === "beta" && op === operation), operation);
});

test("T4: unavailable, malformed, foreign and unknown payment evidence cannot cancel or release stock", async () => {
  const bound = snapshot();
  for (const result of [null, {}, payment(bound, "FUTURE"), { ...payment(bound), customer: "foreign" }, { ...payment(bound), value: 1 }, { ...payment(bound), id: "foreign" }, "404"]) {
    const effects = [];
    const { profiles } = await registry({ clients: { alpha: { getPayment: async () => { if (result === "404") throw Object.assign(new Error("missing"), { status: 404 }); return result; }, deletePayment: async () => effects.push("delete") } } });
    const store = { getCheckoutRecovery: async () => ({ profileId: bound.profileId, order: bound, pricing: bound.pricing, providerCustomerId: bound.providerCustomerId }),
      claimBoundAction: async () => effects.push("claim"), adminCancelUnpaidOrder: async () => effects.push("release") };
    await assert.rejects(() => cancelBoundGalaticPayment({ store, paymentProfiles: profiles, order: bound }));
    assert.deepEqual(effects, []);
  }
});

test("T3/T4: recovery refuses canceled/deleted, future status, malformed IDs and nonzero pagination before attach or completion", async () => {
  const bound = snapshot(); const effects = []; let result;
  const { profiles, gate } = await registry({ clients: { alpha: { findPaymentsByExternalReference: async () => result } } });
  const store = { getCheckoutRecovery: async () => ({ profileId: "alpha", key: "synthetic-key", state: "uncertain", order: bound,
    pricing: bound.pricing, providerCustomerId: bound.providerCustomerId }), attachPayment: async () => effects.push("attach"),
    completeCheckoutAttempt: async () => effects.push("complete"), updateOrderFromWebhook: async () => effects.push("mutate") };
  const recover = createGalaticPaymentRecovery({ store, paymentProfiles: profiles, financialGate: gate });
  for (const payload of [{ ...payment(bound), status: "CANCELED" }, { ...payment(bound), status: "DELETED" },
    { ...payment(bound), status: "FUTURE" }, { ...payment(bound), id: { toString: () => "pay_shared" } }, null,
    { ...payment(bound), value: "100" }, { ...payment(bound), deleted: true }]) {
    result = { data: [payload], hasMore: false, totalCount: 1, offset: 0 };
    await assert.rejects(() => recover({ key: "synthetic-key" }), { code: "payment_reconciliation_conflict" }); assert.deepEqual(effects, []);
  }
  result = { data: [payment(bound)], hasMore: false, totalCount: 1, offset: 10 };
  await assert.rejects(() => recover({ key: "synthetic-key" }), { code: "payment_reconciliation_conflict" }); assert.deepEqual(effects, []);
});

test("T3/T4: initial create response with invalid status or identity preserves the claim and reservation", async (t) => {
  const effects = []; let responsePatch = { status: "CANCELED" };
  const order = { ...snapshot(), id: randomUUID(), subtotalCents: 10000, shippingCents: 0 };
  const store = Object.assign(createInMemoryStore(), ledger(), {
    getCheckoutAttemptResult: async () => null, prepareOrder: async () => ({ kind: "created", order }),
    beginPaymentCreation: async () => effects.push("claim"), markPaymentCreationUncertain: async () => effects.push("uncertain"),
    attachPayment: async () => effects.push("attach"), releaseFailedOrder: async () => effects.push("release"),
  });
  const runtime = createApp({ ...source([entries[0]]), NODE_ENV: "test", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.example",
    GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", GALATIC_SALES_ENABLED: "true" }, { stores: { galatic: store },
    createGalaticAsaasClient: () => ({ getWallets: async () => wallet(walletA), findCustomersByDocument: async () => ({ data: [{ id: order.providerCustomerId }] }),
      createPayment: async (payload) => ({ ...payload, id: order.providerOrderId, status: "PENDING", ...responsePatch }) }) });
  await runtime.ready; const server = runtime.app.listen(0, "127.0.0.1"); t.after(() => server.close()); await new Promise((resolve) => server.once("listening", resolve));
  for (const patch of [{ status: "CANCELED" }, { status: "FUTURE" }, { id: {} }, { deleted: true }]) {
    responsePatch = patch; effects.length = 0;
    const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/checkout/orders`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ items: [{ sku: "SYNTHETIC", quantity: 1 }], buyer: { firstName: "Synthetic", lastName: "Buyer", email: "synthetic@example.test", phone: "11999999999", documentNumber: "52998224725",
        address: { postalCode: "01001000", street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP" } }, shipping: { quoteId: randomUUID() }, payment: { method: "pix" } }) });
    assert.equal(result.status, 202); assert.deepEqual(effects, ["claim", "uncertain"]);
  }
});

test("T5: profile webhook authentication is exclusive, including Academy and previous-token ambiguity", async () => {
  const { profiles } = await registry();
  assert.equal(profiles.authenticateProfileWebhook("alpha", "alpha-synthetic-hook").profileId, "alpha");
  assert.throws(() => profiles.authenticateProfileWebhook("beta", "alpha-synthetic-hook"), { code: "invalid_webhook_token" });
  for (const config of [{ ...source(), GALATIC_BETA_TOKEN: "alpha-synthetic-hook" },
    { ...source(), ASAAS_WEBHOOK_TOKEN: "alpha-synthetic-hook" }]) {
    const broken = await registry({ config });
    assert.equal((await broken.profiles.getPaymentReadiness()).profileStatus, "invalid");
    assert.throws(() => broken.profiles.authenticateProfileWebhook("alpha", "alpha-synthetic-hook"));
    assert.deepEqual(broken.calls, []);
  }
  const rotatedEntry = { ...entries[0], previousWebhookTokenEnv: "GALATIC_ALPHA_PREVIOUS" };
  const rotated = await registry({ config: { ...source([rotatedEntry]), GALATIC_ALPHA_PREVIOUS: "alpha-old" } });
  assert.equal(rotated.profiles.authenticateProfileWebhook("alpha", "alpha-old").profileId, "alpha");
  const hashConflict = await registry({ legacyWebhookAuthentication: { asaasWebhookTokenHash: createHash("sha256").update("alpha-synthetic-hook").digest("hex") } });
  assert.equal((await hashConflict.profiles.getPaymentReadiness()).profileStatus, "invalid");
  const malformed = await registry({ config: { ...source(), GALATIC_ALPHA_TOKEN: "invalid\nheader" } });
  assert.equal((await malformed.profiles.getPaymentReadiness()).profileStatus, "invalid");
});

test("T6: immutable client generations permit only same-wallet rotation and reject metadata changes", async () => {
  const store = ledger(); const requests = [];
  const config = source([entries[0]]);
  const fetcher = async (url, options) => { requests.push([url, options.headers.access_token]); return new Response(JSON.stringify(url.endsWith("/wallets/") ? wallet(walletA) : {})); };
  const old = await registry({ store, config, fetcher });
  config.GALATIC_ALPHA_KEY = "changed-after-capture";
  await (await old.profiles.getVerifiedClient({ profileId: "alpha" }, "read")).client.getPayment("pay_shared");
  assert.equal(requests.at(-1)[1], "alpha-synthetic-key");
  const rotated = await registry({ store, config: { ...source([entries[0]]), GALATIC_ALPHA_KEY: "rotated-key" }, fetcher });
  const rotatedClient = await rotated.profiles.getVerifiedClient({ profileId: "alpha" }, "read");
  await rotatedClient.client.getPayment("pay_shared"); assert.equal(requests.at(-1)[1], "rotated-key");
  assert.notEqual((await old.profiles.getVerifiedClient({ profileId: "alpha" }, "read")).generation, rotatedClient.generation);
  const wrong = await registry({ store, clients: { alpha: { getWallets: async () => wallet(walletB) } } });
  await assert.rejects(() => wrong.profiles.getVerifiedClient({ profileId: "alpha" }, "read"), { code: "payment_profile_verification_expired" });
  const changed = await registry({ store, config: source([entry("alpha", walletA, "production")]) });
  assert.equal((await changed.profiles.getPaymentReadiness()).profileStatus, "invalid");
  assert.equal(store.identities.get("alpha"), profileIdentityHash(entries[0]));
});

test("T7: an action snapshot checks complete refund identity, pagination and every installment", async () => {
  const bound = snapshot("alpha", 2); let result;
  const { profiles } = await registry({ config: source(entries, "beta"), clients: { alpha: {
    getPayment: async () => result.data[0], listInstallmentPayments: async () => result }, beta: { getPayment: async () => assert.fail("wrong action profile") } } });
  const proof = () => loadGalaticPaymentProof({ store: {}, paymentProfiles: profiles, order: bound, snapshot: bound, capability: "refund" });
  result = { data: [payment(bound, "REFUNDED"), payment(bound, "CONFIRMED", 2)], hasMore: false, totalCount: 2 };
  assert.equal((await proof()).refunded, false);
  result.data[1] = payment(bound, "REFUNDED", 2); assert.equal((await proof()).refunded, true);
  for (const mutate of [(r) => { r.hasMore = true; }, (r) => { r.data[1].customer = "foreign"; },
    (r) => { r.data[1].installment = "foreign"; }, (r) => { r.data[1].externalReference = "galatic:foreign"; }, (r) => { r.data[1].value = 1; }]) {
    result = { data: [payment(bound, "REFUNDED"), payment(bound, "REFUNDED", 2)], hasMore: false, totalCount: 2 }; mutate(result);
    await assert.rejects(proof);
  }
});

test("T8: explicit complete unpaid proof is required before claim and DELETE; DELETE404 keeps stock", async () => {
  const bound = snapshot("alpha", 2); let states = ["PENDING", "CONFIRMED"]; const effects = [];
  const { profiles } = await registry({ clients: { alpha: { getPayment: async () => payment(bound, states[0]),
    listInstallmentPayments: async () => ({ data: states.map((state, i) => payment(bound, state, i + 1)), hasMore: false, totalCount: 2 }),
    deleteInstallment: async () => { effects.push("delete"); throw Object.assign(new Error("missing"), { status: 404 }); } } } });
  const store = { getCheckoutRecovery: async () => ({ profileId: "alpha", order: bound, pricing: bound.pricing, providerCustomerId: bound.providerCustomerId }),
    claimBoundAction: async () => (effects.push("claim"), { claimed: true, ...bound, providerReference: "ins_shared", group: true, version: 1 }),
    finishCancellationRequest: async (_id, _profile, _version, state) => effects.push(state), adminCancelUnpaidOrder: async () => effects.push("release") };
  const cancel = () => cancelBoundGalaticPayment({ store, paymentProfiles: profiles, order: bound });
  await assert.rejects(cancel); assert.deepEqual(effects, []);
  states = ["PENDING", "PENDING"]; await assert.rejects(cancel);
  assert.deepEqual(effects, ["claim", "delete", "uncertain"]);
});

test("T7/T8/T9: anchor identity, state and reversals must agree with the complete group", async () => {
  const bound = snapshot("alpha", 2); let anchor; let group;
  const { profiles } = await registry({ clients: { alpha: { getPayment: async () => anchor,
    listInstallmentPayments: async () => ({ data: group, hasMore: false, totalCount: 2 }) } } });
  const proof = () => loadGalaticPaymentProof({ store: {}, paymentProfiles: profiles, order: bound, snapshot: bound, capability: "cancel" });
  for (const [anchorState, groupState, patch] of [["PENDING", "PENDING", { customer: "foreign" }],
    ["PENDING", "PENDING", { externalReference: "galatic:foreign" }], ["PENDING", "PENDING", { billingType: "PIX" }],
    ["CONFIRMED", "PENDING", {}], ["REFUNDED", "CONFIRMED", {}], ["PENDING", "REFUNDED", {}],
    ["CONFIRMED", "CONFIRMED", { refundedValue: 1 }]]) {
    anchor = { ...payment(bound, anchorState), ...patch }; group = [1, 2].map((i) => payment(bound, groupState, i));
    await assert.rejects(proof);
  }
  anchor = payment(bound, "PENDING"); group = [1, 2].map((i) => payment(bound, "PENDING", i));
  assert.equal((await proof()).unpaid, true);
});

test("T9/T12: production approval and capability are separate persisted default-deny gates", async () => {
  const store = ledger(); const config = source([entry("alpha", walletA, "production")]);
  const { profiles } = await registry({ store, config });
  await assert.rejects(() => profiles.getVerifiedClient({ profileId: "alpha" }, "fulfillment"), { code: "payment_profile_commercial_approval_required" });
  store.authorizations.set("alpha", { capabilities: ["read"], commercialApproved: true, evidenceReference: "synthetic-review" });
  await assert.rejects(() => profiles.getVerifiedClient({ profileId: "alpha" }, "checkout"), { code: "payment_profile_capability_denied" });
  assert.equal((await profiles.getVerifiedClient({ profileId: "alpha" }, "read")).environment, "production");
  store.authorizations.set("alpha", { capabilities: "checkout", commercialApproved: true, evidenceReference: "synthetic-review" });
  await assert.rejects(() => profiles.getVerifiedClient({ profileId: "alpha" }, "checkout"), { code: "payment_profile_capability_denied" });
  store.authorizations.set("alpha", { capabilities: ["checkout"], commercialApproved: "true", evidenceReference: "synthetic-review" });
  await assert.rejects(() => profiles.getVerifiedClient({ profileId: "alpha" }, "checkout"), { code: "payment_profile_commercial_approval_required" });
});

test("T11: one profile outage cannot suppress another profile or the mail outbox", async () => {
  const boundA = snapshot("alpha"), boundB = { ...snapshot("beta"), id: "second-order" }; const effects = [];
  const { profiles } = await registry({ clients: { alpha: { getPayment: async () => { throw new Error("profile-down"); } },
    beta: { getPayment: async () => payment(boundB, "CONFIRMED") } } });
  const store = { listExpiredPaymentReservations: async () => [boundA, boundB],
    getCheckoutRecovery: async ({ orderId }) => { const bound = orderId === boundA.id ? boundA : boundB; return { profileId: bound.profileId, order: bound, pricing: bound.pricing, providerCustomerId: bound.providerCustomerId }; },
    updateOrderFromWebhook: async (input) => effects.push(input.profileId), recordOperationalAlert: async () => {} };
  const worker = createGalaticPaymentMaintenance({ environment: { galaticPaymentMaintenanceEnabled: true, galaticPixReservationMinutes: 1, galaticCardReservationMinutes: 1 },
    store, paymentProfiles: profiles, financialGate: createGalaticFinancialGate({ enabled: true }) });
  const result = await worker.run(); assert.equal(result.failed, 1); assert.equal(result.paid, 1); assert.deepEqual(effects, ["beta"]);
});

test("TTL expiration blocks dispatch until an explicit fresh identity verification; false guard performs zero wallet I/O", async () => {
  let now = 0; const { profiles, calls } = await registry({ clock: () => now });
  const held = await profiles.getVerifiedClient({ profileId: "alpha" }, "read"); now = 900001;
  await assert.rejects(() => profiles.getVerifiedClient({ profileId: "alpha" }, "read"), { code: "payment_profile_verification_expired" });
  await assert.rejects(() => held.client.getWallets(), { code: "payment_profile_verification_expired" });
  assert.equal(calls.length, 2); await profiles.verifyProfile("alpha"); await profiles.getVerifiedClient({ profileId: "alpha" }, "read");
  assert.equal(calls.length, 3);
  const paused = await registry({ enabled: false }); assert.deepEqual(paused.calls, []);
  await paused.profiles.getPaymentReadiness(); await assert.rejects(() => paused.profiles.verifyProfile("alpha")); assert.deepEqual(paused.calls, []);
});

test("wallet verification requires one valid pinned ID and complete coherent pagination", () => {
  assert.doesNotThrow(() => assertWalletIdentity(wallet(walletA), walletA));
  for (const payload of [{}, { ...wallet(walletA), hasMore: true }, { ...wallet(walletA), totalCount: 2 },
    { ...wallet(walletA), offset: 1 }, { ...wallet(walletA), data: [] }, wallet(walletB), { ...wallet(walletA), data: [{ object: "wallet", id: "invalid" }] }]) {
    assert.throws(() => assertWalletIdentity(payload, walletA), { code: "payment_profile_wallet_mismatch" });
  }
});

test("new checkout requires a captured exclusive webhook credential even with verified wallet and capabilities", async () => {
  const config = source([entries[0]]); delete config.GALATIC_ALPHA_TOKEN;
  const effects = [];
  const { profiles } = await registry({ config, clients: { alpha: { createCustomer: async () => effects.push("customer"), createPayment: async () => effects.push("payment") } } });
  assert.equal((await profiles.getPaymentReadiness()).checkoutAvailable, false);
  await assert.rejects(() => profiles.resolveNewOrderProfile(), { code: "payment_profile_webhook_unconfigured" });
  config.GALATIC_ALPHA_TOKEN = "injected-after-startup";
  await assert.rejects(() => profiles.resolveNewOrderProfile(), { code: "payment_profile_webhook_unconfigured" });
  assert.equal((await profiles.getVerifiedClient({ profileId: "alpha" }, "read")).profileId, "alpha", "explicit historical read policy does not invent webhook credentials");
  assert.deepEqual(effects, []);
});

test("missing profile webhook credential rejects HTTP checkout before inventory, customer or payment claims", async (t) => {
  const config = source([entries[0]]); delete config.GALATIC_ALPHA_TOKEN;
  const effects = [];
  const galatic = Object.assign(createInMemoryStore(), ledger(), { prepareOrder: async () => effects.push("reserve") });
  const runtime = createApp({ ...config, NODE_ENV: "test", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.example",
    GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", GALATIC_SALES_ENABLED: "true" }, { stores: { galatic },
    createGalaticAsaasClient: () => ({ getWallets: async () => wallet(walletA), findCustomersByDocument: async () => effects.push("customer-lookup"),
      createCustomer: async () => effects.push("customer-post"), createPayment: async () => effects.push("payment-post") }) });
  await runtime.ready;
  const server = runtime.app.listen(0, "127.0.0.1"); t.after(() => server.close()); await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/checkout/orders`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "56b161c6-425b-4a8d-856e-12c3ac544cd1" },
    body: JSON.stringify({ items: [{ sku: "SYNTHETIC", quantity: 1 }], buyer: { firstName: "Synthetic", lastName: "Buyer", email: "synthetic@example.test",
      phone: "11999999999", documentNumber: "52998224725", address: { postalCode: "01001000", street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP" } },
      shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" }, payment: { method: "pix" } }) });
  assert.equal(response.status, 503); assert.equal((await response.json()).error, "payment_profile_webhook_unconfigured"); assert.deepEqual(effects, []);
});
