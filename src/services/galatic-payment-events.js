import { closedGalaticFinancialGate } from "./galatic-financial-gate.js";
import { loadGalaticPaymentProof } from "./galatic-payment-proof.js";

// SQL retains immutable receipts; provider reads happen here, after every
// transaction/lock has been released. An old receipt is not current proof.
export function createGalaticDeferredEventReconciliation({ store, paymentProfiles, financialGate = closedGalaticFinancialGate }) {
  return (query = {}) => financialGate.run(async () => {
    const result = { inspected: 0, applied: 0, pending: 0, lastApplied: null };
    if (!store.claimPendingAuthenticatedEvents) return result;
    for (const event of await store.claimPendingAuthenticatedEvents(query)) {
      result.inspected += 1;
      try {
        const operation = await store.getCheckoutRecovery({ orderId: event.orderId });
        if (!operation || operation.profileId !== event.profileId || operation.order.profileId !== event.profileId) { result.pending += 1; continue; }
        const proof = await loadGalaticPaymentProof({ store, paymentProfiles, order: operation.order, capability: "webhook" });
        if (!proof.status || proof.status === "canceled" || proof.status !== event.status
          || (proof.status === "refunded" && !proof.refunded)) { result.pending += 1; continue; }
        const applied = await store.updateOrderFromWebhook({ profileId: event.profileId, provider: "asaas",
          providerOrderId: proof.providerOrderId, providerGroupId: proof.providerGroupId, eventId: event.eventId,
          status: proof.status, completeGroupProof: true });
        if (applied?.id) { result.applied += 1; result.lastApplied = applied; }
        else result.pending += 1;
      } catch { result.pending += 1; }
    }
    return result;
  });
}
