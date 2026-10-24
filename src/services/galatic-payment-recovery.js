import { createGalaticDeferredEventReconciliation } from "./galatic-payment-events.js";
import { closedGalaticFinancialGate } from "./galatic-financial-gate.js";
import { matchesGalaticPayment, galaticPaymentResponse, completeGalaticPaymentList } from "../domain/galatic-payment.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";

export function createGalaticPaymentRecovery({ store, paymentProfiles, financialGate = closedGalaticFinancialGate }) {
  const reconcileDeferred = createGalaticDeferredEventReconciliation({ store, paymentProfiles, financialGate });
  return function recover(query) {
    return financialGate.run(async () => {
      const operation = await store.getCheckoutRecovery(query);
      if (!operation || !["creating", "uncertain", "attached"].includes(operation.state)) return null;
      const { order, pricing } = operation;
      if (!pricing || !operation.profileId || order.profileId !== operation.profileId) return null;
      const { client: asaasClient } = await paymentProfiles.getVerifiedClient(operation, "recovery");
      const result = await asaasClient.findPaymentsByExternalReference(`galatic:${order.id}`);
      const payments = result?.data;
      // An empty list can mean the accepted request is still processing.
      if (!Array.isArray(payments) || payments.length === 0) throw Object.assign(new Error("payment_not_yet_found"), { code: "payment_not_yet_found" });
      const valid = completeGalaticPaymentList(result, order.installments)
        && payments.every((payment) => matchesGalaticPayment(payment, operation, { installment: order.installments > 1 }))
        && new Set(payments.map((payment) => payment.installment || payment.id)).size === 1
        && new Set(payments.map((payment) => payment.id)).size === payments.length
        && Math.abs(payments.reduce((sum, payment) => sum + Math.round(Number(payment.value) * 100), 0) - pricing.totalCents) <= 1;
      if (!valid) throw Object.assign(new Error("payment_reconciliation_conflict"), { code: "payment_reconciliation_conflict" });
      const payment = [...payments].sort((a, b) => Number(a.installmentNumber ?? 1) - Number(b.installmentNumber ?? 1))[0];
      financialGate.assertEnabled();
      for (const item of payments) await store.attachPayment(order.id, item.id, order.installments > 1 ? "processing" : normalizeAsaasPaymentStatus(item.status), {
        profileId: operation.profileId, method: order.method, installments: order.installments, installmentAmountCents: pricing.installmentCents,
        paymentFeeCents: pricing.feeCents, totalCents: pricing.totalCents, providerGroupId: item.installment ?? null,
      });
      const statuses = new Set(payments.map((item) => normalizeAsaasPaymentStatus(item.status)));
      if (statuses.size === 1) await store.updateOrderFromWebhook({ profileId: operation.profileId, provider: "asaas",
        providerOrderId: payment.id, providerGroupId: payment.installment ?? null, status: [...statuses][0], completeGroupProof: true });
      await reconcileDeferred({ profileId: operation.profileId, orderId: order.id });
      const current = await store.getOrderByPublicId(order.id);
      let instructions = null;
      if (order.method === "pix" && current?.status !== "paid") {
        try {
          const qr = await asaasClient.getPixQrCode(payment.id);
          if (qr?.encodedImage && qr?.payload) instructions = { qrCodeBase64: qr.encodedImage, emv: qr.payload, expiresAt: qr.expirationDate ?? null };
        } catch {}
      }
      const response = galaticPaymentResponse(order, pricing, current?.status ?? normalizeAsaasPaymentStatus(payment.status), instructions);
      financialGate.assertEnabled();
      await store.completeCheckoutAttempt(operation.key, response);
      return response;
    });
  };
}
