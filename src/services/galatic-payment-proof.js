import { matchesGalaticPayment, completeGalaticPaymentList } from "../domain/galatic-payment.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";
import { paymentProfileError } from "./galatic-payment-profiles.js";

const UNPAID = new Set(["PENDING", "OVERDUE"]);
export const hasPaymentReversal = (payment) => Number(payment.refundedValue) > 0 || (Array.isArray(payment.refunds) && payment.refunds.length > 0);

// Use a claimed action snapshot for actions, otherwise the durable checkout
// attempt. An order bound later does not establish an old action's provenance.
export async function loadGalaticPaymentProof({ store, paymentProfiles, order, snapshot = null, capability = "read" }) {
  if (!paymentProfiles) throw paymentProfileError("payment_profile_unconfigured");
  const operation = snapshot ? { profileId: snapshot.profileId, order: snapshot,
    pricing: snapshot.pricing, providerCustomerId: snapshot.providerCustomerId }
    : await store.getCheckoutRecovery?.({ orderId: order.id });
  if (!operation?.profileId || operation.profileId !== (order.profileId ?? order.payment_profile_id)
    || operation.order?.profileId !== operation.profileId || !operation.providerCustomerId || !operation.pricing
    || operation.order.id !== order.id) throw paymentProfileError("payment_profile_evidence_missing");
  const bound = await paymentProfiles.getVerifiedClient(operation, capability);
  const { client } = bound; const expected = operation.order;
  const providerOrderId = expected.providerOrderId;
  const providerGroupId = expected.providerGroupId ?? null;
  const count = Number(expected.installments);
  if (!providerOrderId || !Number.isInteger(count) || count < 1 || count > 10
    || !["pix", "credit_card"].includes(expected.method) || (expected.method === "pix" && count !== 1)
    || !Number.isSafeInteger(operation.pricing.totalCents) || operation.pricing.totalCents <= 0
    || (expected.totalCents !== undefined && expected.totalCents !== operation.pricing.totalCents)) throw paymentProfileError("payment_proof_invalid");
  const eligible = (p) => matchesGalaticPayment(p, operation, { installment: count > 1, allowDeletedTerminal: true });
  const anchorFacts = (p) => JSON.stringify([p.id, p.customer, p.externalReference, p.billingType, Number(p.value), p.installment ?? null,
    p.status, p.deleted ?? false, Number(p.refundedValue ?? 0), p.refunds ?? []]);
  const linked = await client.getPayment(providerOrderId);
  if (!eligible(linked)) throw paymentProfileError("payment_proof_mismatch");
  let payments = [linked];
  if (count > 1) {
    if (!providerGroupId || linked?.installment !== providerGroupId) throw paymentProfileError("payment_proof_mismatch");
    const result = await client.listInstallmentPayments(providerGroupId);
    if (!completeGalaticPaymentList(result, count)) throw paymentProfileError("payment_proof_incomplete");
    payments = result.data;
    const anchor = payments.find((p) => p?.id === linked.id);
    if (!anchor || anchorFacts(linked) !== anchorFacts(anchor)) throw paymentProfileError("payment_proof_inconsistent");
  } else if (providerGroupId) throw paymentProfileError("payment_proof_mismatch");
  if (linked?.id !== providerOrderId || payments.length !== count || new Set(payments.map((p) => p?.id)).size !== count
    || !payments.some((p) => p?.id === providerOrderId)
    || !payments.every((p) => eligible(p)
      && (count === 1 || p.installment === providerGroupId))
    || Math.abs(payments.reduce((sum, p) => sum + Math.round(Number(p.value) * 100), 0) - operation.pricing.totalCents) > 1) {
    throw paymentProfileError("payment_proof_mismatch");
  }
  const statuses = new Set(payments.map((p) => normalizeAsaasPaymentStatus(p.status)));
  return { ...bound, operation, payments, payment: linked, providerOrderId, providerGroupId,
    status: statuses.size === 1 ? [...statuses][0] : null,
    unpaid: payments.every((p) => UNPAID.has(p.status) && !hasPaymentReversal(p)),
    paid: payments.every((p) => normalizeAsaasPaymentStatus(p.status) === "paid" && !p.deleted && !hasPaymentReversal(p)),
    refunded: payments.every((p) => normalizeAsaasPaymentStatus(p.status) === "refunded") };
}

export async function cancelBoundGalaticPayment({ store, paymentProfiles, order, adminId = "maintenance" }) {
  // A missing reference is not proof of an unsubmitted legacy operation.
  if (!order?.profileId) throw paymentProfileError("payment_profile_unknown");
  if (!order.providerOrderId) {
    await paymentProfiles.getVerifiedClient(order, "cancel");
    return store.adminCancelUnpaidOrder(order.id, { profileId: order.profileId });
  }
  const before = await loadGalaticPaymentProof({ store, paymentProfiles, order, capability: "cancel" });
  if (!before.unpaid) throw paymentProfileError("payment_not_explicitly_unpaid");
  const claim = await store.claimBoundAction({ orderId: order.id, adminId, kind: "cancel" });
  if (!claim.claimed) throw paymentProfileError("payment_cancellation_reconciliation_required");
  try {
    const proof = await loadGalaticPaymentProof({ store, paymentProfiles, order: claim, snapshot: claim, capability: "cancel" });
    if (!proof.unpaid) throw paymentProfileError("payment_not_explicitly_unpaid");
    const result = claim.group ? await proof.client.deleteInstallment(claim.providerReference) : await proof.client.deletePayment(claim.providerReference);
    if (result?.deleted !== true) throw paymentProfileError("payment_deletion_unconfirmed");
    const canceled = await store.adminCancelUnpaidOrder(order.id, { profileId: claim.profileId, version: claim.version, completeUnpaidProof: true });
    await store.finishCancellationRequest(order.id, claim.profileId, claim.version, canceled ? "completed" : "uncertain");
    return canceled;
  } catch (error) { await store.finishCancellationRequest(order.id, claim.profileId, claim.version, "uncertain"); throw error; }
}
