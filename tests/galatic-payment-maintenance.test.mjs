import { syntheticAction, syntheticPayment, addSyntheticOrderProof } from "./helpers/payment-profiles.mjs";
import { createGalaticFinancialGate } from "../src/services/galatic-financial-gate.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createGalaticPaymentMaintenance } from "./helpers/payment-profiles.mjs";

function environment() {
  return { galaticPaymentMaintenanceEnabled: true, galaticPixReservationMinutes: 60,
    galaticCardReservationMinutes: 4320 };
}

test("cancels stale unpaid charges at Asaas before releasing their stock", async () => {
  const calls = [];
  const snapshot = syntheticAction({ id: "order-pix", providerOrderId: "pay-pix" });
  const store = {
    listExpiredPaymentReservations: async () => [{ profileId: snapshot.profileId, id: "order-pix", providerOrderId: "pay-pix", providerGroupId: null }],
    adminCancelUnpaidOrder: async (id) => { calls.push(["cancel-local", id]); return true; },
  };
  const asaasClient = { ...addSyntheticOrderProof(store, snapshot),
    getPayment: async (id) => { calls.push(["read", id]); return syntheticPayment(snapshot, "PENDING"); },
    deletePayment: async (id) => { calls.push(["delete", id]); return { deleted: true }; },
  };
  const maintenance = createGalaticPaymentMaintenance({ financialGate: createGalaticFinancialGate({ enabled: true }), environment: environment(), store, asaasClient, clock: () => 1_800_000_000_000 });
  assert.deepEqual(await maintenance.run(), { inspected: 1, canceled: 1, paid: 0, failed: 0 });
  assert.deepEqual(calls, [["read", "pay-pix"], ["read", "pay-pix"], ["read", "pay-pix"], ["delete", "pay-pix"], ["cancel-local", "order-pix"]]);
});

test("never cancels a stale local reservation when Asaas already received payment", async () => {
  const calls = [];
  const snapshot = syntheticAction({ id: "order-paid", providerOrderId: "pay-paid" });
  const store = {
    listExpiredPaymentReservations: async () => [{ profileId: snapshot.profileId, id: "order-paid", providerOrderId: "pay-paid", providerGroupId: null }],
    updateOrderFromWebhook: async (value) => { calls.push(["paid-local", value.providerOrderId]); },
    adminCancelUnpaidOrder: async () => { throw new Error("must not cancel paid order"); },
  };
  const asaasClient = { ...addSyntheticOrderProof(store, snapshot),
    deletePayment: async () => { throw new Error("must not delete paid charge"); },
  };
  const maintenance = createGalaticPaymentMaintenance({ financialGate: createGalaticFinancialGate({ enabled: true }), environment: environment(), store, asaasClient });
  assert.deepEqual(await maintenance.run(), { inspected: 1, canceled: 0, paid: 1, failed: 0 });
  assert.deepEqual(calls, [["paid-local", "pay-paid"]]);
});

test("removes the full Asaas installment group for an abandoned card order", async () => {
  let removed = null;
  const snapshot = syntheticAction({ id: "order-card", providerOrderId: "pay-card", providerGroupId: "ins-card", installments: 2 });
  const store = {
    listExpiredPaymentReservations: async () => [{ profileId: snapshot.profileId, id: "order-card", providerOrderId: "pay-card", providerGroupId: "ins-card" }],
    adminCancelUnpaidOrder: async () => true,
  };
  const asaasClient = { ...addSyntheticOrderProof(store, snapshot),
    getPayment: async () => syntheticPayment(snapshot, "PENDING"),
    listInstallmentPayments: async () => ({ hasMore: false, totalCount: 2, data: [1,2].map((i) => syntheticPayment(snapshot, "PENDING", i)) }),
    deleteInstallment: async (id) => { removed = id; return { deleted: true }; },
  };
  const maintenance = createGalaticPaymentMaintenance({ financialGate: createGalaticFinancialGate({ enabled: true }), environment: environment(), store, asaasClient });
  assert.equal((await maintenance.run()).canceled, 1);
  assert.equal(removed, "ins-card");
});

test("inconclusive refund polling passes its attempt version without treating refund array entries as current authorization or completion", async () => {
  const errors = []; const updates = []; let failRead = false;
  const snapshot = syntheticAction({ id: "order-refund", providerOrderId: "pay_owned", version: 7 });
  const store = {
    listExpiredPaymentReservations: async () => [],
    claimRefundReconciliations: async () => [snapshot],
    recordRefundReconciliationError: async (...args) => { errors.push(args); },
    updateOrderFromWebhook: async (value) => { updates.push(value); },
  };
  const asaasClient = { getPayment: async () => {
    if (failRead) throw Object.assign(new Error("synthetic"), { code: "read_unavailable" });
    return { ...syntheticPayment(snapshot, "RECEIVED"), refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }, { status: "DONE" }] };
  }, refundPayment: async () => assert.fail("maintenance must not mutate a refund") };
  const maintenance = createGalaticPaymentMaintenance({ financialGate: createGalaticFinancialGate({ enabled: true }), environment: environment(), store, asaasClient });
  await maintenance.run(); failRead = true; await maintenance.run();
  assert.deepEqual(errors, [["order-refund", "refund_not_yet_confirmed", 7], ["order-refund", "read_unavailable", 7]]);
  assert.deepEqual(updates, []);
});
