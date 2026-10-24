import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validGalaticProviderPayment, matchesGalaticPayment } from "../src/domain/galatic-payment.js";
import { createGalaticFinancialGate } from "../src/services/galatic-financial-gate.js";
import { createGalaticPaymentRecovery } from "../src/services/galatic-payment-recovery.js";
import { loadGalaticPaymentProof, cancelBoundGalaticPayment } from "../src/services/galatic-payment-proof.js";
import { createGalaticFulfillmentService } from "../src/services/galatic-fulfillment.js";
import { createApp, syntheticAction, syntheticProfiles, PROFILE_ID } from "./helpers/payment-profiles.mjs";

// Synthetic Asaas-shaped data. refunds:null was observed in the read-only
// reconciliation; installmentNumber:null is an official DTO example, not an
// observation claimed from that run. No provider/customer identifiers are reused.
const bound = () => syntheticAction({ id: randomUUID(), providerOrderId: "pay_nullable_synthetic", totalCents: 1500 });
const dto = (order, patch = {}) => ({ object: "payment", id: order.providerOrderId, customer: order.providerCustomerId,
  billingType: "PIX", value: order.totalCents / 100, externalReference: `galatic:${order.id}`, description: `Pedido Galatic ${order.id}`,
  dueDate: "2030-01-01", status: "PENDING", deleted: false, installment: null, installmentNumber: null, refunds: null, ...patch });
const gate = () => createGalaticFinancialGate({ enabled: true });

test("the two optional provider metadata fields accept actual null independently and together", () => {
  const order = bound(), absent = dto(order); delete absent.refunds; delete absent.installmentNumber;
  for (const payment of [absent, { ...absent, refunds: null }, { ...absent, installmentNumber: null }, dto(order)]) {
    assert.equal(validGalaticProviderPayment(payment), true);
    assert.equal(matchesGalaticPayment(payment, { order, pricing: order.pricing, providerCustomerId: order.providerCustomerId }), true);
  }
});

test("present optional metadata stays strict, without coercing refund arrays or unrelated fields", () => {
  const order = bound(), base = dto(order); delete base.refunds; delete base.installmentNumber;
  for (const refunds of ["", "[]", {}, false, true, 0, 1, [null], [false], [[]]]) assert.equal(validGalaticProviderPayment({ ...base, refunds }), false);
  for (const installmentNumber of ["1", false, true, 0, -1, 11, 1.5]) assert.equal(validGalaticProviderPayment({ ...base, installmentNumber }), false);
  for (const installmentNumber of [1, 10]) assert.equal(validGalaticProviderPayment({ ...base, installmentNumber }), true);
  assert.equal(validGalaticProviderPayment({ ...base, refundedValue: null }), false);
  const refunds = [{ status: "REQUESTED", value: 1 }], payment = { ...base, refunds };
  assert.equal(validGalaticProviderPayment(payment), true); assert.strictEqual(payment.refunds, refunds); assert.equal(payment.refunds.length, 1);
});

test("HTTP checkout accepts nullable Asaas metadata and preserves bound profile, identity and totals", async (t) => {
  const order = { ...bound(), subtotalCents: 1000, shippingCents: 500 }, effects = [], captured = {};
  const store = { ensureSchema: async () => {}, close: async () => {}, getCheckoutAttemptResult: async () => null, getOrderByPublicId: async () => ({ ...order, status: "open" }),
    prepareOrder: async (input) => { assert.equal(input.profileId, PROFILE_ID); return { kind: "created", order }; },
    beginPaymentCreation: async (_key, id, details) => { assert.equal(id, order.id); captured.claim = details; },
    attachPayment: async (...args) => { captured.attach = args; }, completeCheckoutAttempt: async (_key, response) => { captured.response = response; },
    markPaymentCreationUncertain: async () => effects.push("uncertain"), releaseFailedOrder: async () => effects.push("release") };
  const client = { findCustomersByDocument: async () => ({ data: [{ id: order.providerCustomerId }] }),
    createPayment: async (payload) => { captured.payload = payload; return { ...dto(order), ...payload }; },
    updatePayment: async () => ({}), getPixQrCode: async () => ({ encodedImage: "SYNTHETIC", payload: "SYNTHETIC_PIX" }) };
  const runtime = createApp({ NODE_ENV: "test", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.example",
    GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", GALATIC_SALES_ENABLED: "true" }, { stores: { galatic: store }, asaasClient: client });
  await runtime.ready; const server = runtime.app.listen(0, "127.0.0.1"); t.after(() => server.close()); await new Promise(resolve => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/galatic/checkout/orders`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ items: [{ sku: "SYNTHETIC", quantity: 1 }],
      buyer: { firstName: "Synthetic", lastName: "Buyer", email: "synthetic@example.test", phone: "11999999999", documentNumber: "52998224725",
        address: { postalCode: "01001000", street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP" } },
      shipping: { quoteId: randomUUID() }, payment: { method: "pix" } }) });
  assert.equal(response.status, 201); const body = await response.json(); assert.equal(body.orderId, order.id); assert.equal(body.totalCents, 1500); assert.equal(body.status, "open");
  assert.equal(captured.payload.customer, order.providerCustomerId); assert.equal(captured.payload.externalReference, `galatic:${order.id}`); assert.equal(captured.payload.value, 15);
  assert.equal(captured.claim.profileId, PROFILE_ID); assert.equal(captured.attach[0], order.id); assert.equal(captured.attach[1], order.providerOrderId);
  assert.equal(captured.attach[2], "open"); assert.equal(captured.attach[3].profileId, PROFILE_ID); assert.equal(captured.attach[3].totalCents, 1500); assert.deepEqual(effects, []);
});

test("uncertain checkout recovery accepts nullable metadata without a new customer or payment POST", async () => {
  const order = bound(), effects = [], pricing = { ...order.pricing }, operation = { key: randomUUID(), profileId: PROFILE_ID, state: "uncertain", order, pricing, providerCustomerId: order.providerCustomerId };
  const store = { getCheckoutRecovery: async () => operation, attachPayment: async (...args) => effects.push(["attach", ...args]),
    updateOrderFromWebhook: async (input) => effects.push(["status", input]), getOrderByPublicId: async () => ({ ...order, status: "open" }),
    completeCheckoutAttempt: async (key, response) => effects.push(["complete", key, response]) };
  const evidence = dto(order), paymentProfiles = syntheticProfiles(store, {
    findPaymentsByExternalReference: async (reference) => { assert.equal(reference, `galatic:${order.id}`); return { object: "list", data: [evidence], hasMore: false, totalCount: 1, offset: 0, limit: 1 }; },
    getPixQrCode: async () => ({ encodedImage: "SYNTHETIC", payload: "SYNTHETIC_PIX" }), createPayment: async () => assert.fail("No recovery POST"), createCustomer: async () => assert.fail("No recovery customer POST") });
  const recover = createGalaticPaymentRecovery({ store, paymentProfiles, financialGate: gate() }), result = await recover({ key: operation.key });
  assert.equal(result.status, 201); assert.equal(result.body.orderId, order.id); assert.equal(result.body.totalCents, 1500); assert.equal(result.body.status, "open");
  const attach = effects.find(item => item[0] === "attach"); assert.equal(attach[2], order.providerOrderId); assert.equal(attach[4].profileId, PROFILE_ID); assert.equal(attach[4].totalCents, 1500);
  assert.equal(effects.find(item => item[0] === "status")[1].status, "open"); assert.equal(effects.at(-1)[0], "complete"); assert.strictEqual(evidence.refunds, null);
});

function proofFixture(patch = {}) {
  const order = bound(), evidence = dto(order, patch), effects = [];
  const store = { getCheckoutRecovery: async () => ({ profileId: PROFILE_ID, order, pricing: order.pricing, providerCustomerId: order.providerCustomerId }),
    claimBoundAction: async () => { effects.push("claim"); return { ...order, claimed: true, kind: "cancel", group: false, providerReference: order.providerOrderId, referenceKind: "payment", version: 1 }; },
    adminCancelUnpaidOrder: async (_id, proof) => { assert.equal(proof.profileId, PROFILE_ID); effects.push("release"); return true; }, finishCancellationRequest: async () => {} };
  const paymentProfiles = syntheticProfiles(store, { getPayment: async () => evidence, deletePayment: async (id) => { assert.equal(id, order.providerOrderId); effects.push("delete"); return { deleted: true }; } });
  return { order, evidence, effects, store, paymentProfiles };
}

test("only complete owned PENDING or OVERDUE proof can authorize simulated cancellation with null metadata", async () => {
  for (const status of ["PENDING", "OVERDUE"]) {
    const f = proofFixture({ status }), proof = await loadGalaticPaymentProof(f);
    assert.equal(proof.unpaid, true); assert.equal(proof.paid, false); assert.equal(proof.profileId, PROFILE_ID);
    assert.equal(await cancelBoundGalaticPayment(f), true); assert.deepEqual(f.effects, ["claim", "delete", "release"]);
  }
  const paid = proofFixture({ status: "CONFIRMED" }); assert.equal((await loadGalaticPaymentProof(paid)).paid, true);
  await assert.rejects(() => cancelBoundGalaticPayment(paid)); assert.deepEqual(paid.effects, []);
});

test("refunds, reversals and foreign or malformed nullable DTOs never authorize DELETE or an Envia label", async () => {
  const address = { street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" };
  for (const patch of [{ status: "PENDING" }, { status: "OVERDUE" }, { status: "REFUNDED" }, { status: "CONFIRMED", refunds: [{ status: "REQUESTED", value: 1 }] },
    { status: "CONFIRMED", refundedValue: 1 }, { customer: "cus_foreign" }, { id: "pay_foreign" }, { externalReference: "galatic:foreign" }, { value: 16 },
    { status: "FUTURE" }, { installment: "ins_foreign" }, { refunds: [null] }, { installmentNumber: "1" }]) {
    const f = proofFixture(patch), preserved = structuredClone(f.evidence);
    if (!["PENDING", "OVERDUE"].includes(patch.status)) { await assert.rejects(() => cancelBoundGalaticPayment(f)); assert.deepEqual(f.effects, []); }
    Object.assign(f.store, { shipmentForOrder: async () => null, shipmentCreationContext: async () => ({ id: f.order.id,
      payment_profile_id: PROFILE_ID, payment_provider: "asaas", payment_status: "paid", payment_provider_order_id: f.order.providerOrderId, payment_provider_group_id: null,
      payment_method: "pix", installments: 1, total_cents: 1500, service_code: "correios:pac", shipping_address: address,
      items: [{ title: "Synthetic", quantity: 1, unit_amount_cents: 1000, weight_grams: 1000, length_cm: 10, width_cm: 10, height_cm: 10 }] }),
      claimShipmentCreation: async () => assert.fail("No label claim") });
    const fulfillment = createGalaticFulfillmentService({ store: f.store, paymentProfiles: f.paymentProfiles, financialGate: gate(),
      environment: { galaticEnviaEnvironment: "sandbox", galaticShippingOrigin: address }, enviaClient: { ready: true, generateLabel: async () => assert.fail("No Envia call") } });
    await assert.rejects(() => fulfillment.createLabel(f.order.id), { code: "shipping_payment_unverified" }); assert.deepEqual(f.evidence, preserved);
  }
});
