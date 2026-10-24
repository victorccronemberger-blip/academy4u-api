import { matchesGalaticPayment, galaticPaymentResponse } from "../domain/galatic-payment.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";

export function createGalaticPaymentRecovery({ store, asaasClient }) {
  return async function recover(query) {
    const operation = await store.getCheckoutRecovery(query);
    if (!operation || !["creating", "uncertain", "attached"].includes(operation.state)) return null;
    const { order, pricing } = operation;
    if (!pricing || !asaasClient?.findPaymentsByExternalReference) return null;
    const result = await asaasClient.findPaymentsByExternalReference(`galatic:${order.id}`);
    const payments = result?.data;
    // An empty list can mean the accepted request is still processing.
    if (!Array.isArray(payments) || payments.length === 0) throw Object.assign(new Error("payment_not_yet_found"), { code: "payment_not_yet_found" });
    const groups = new Set(payments.map((payment) => payment.installment || payment.id));
    const valid = !result.hasMore && groups.size === 1 && new Set(payments.map((payment) => payment.id)).size === payments.length
      && payments.length === order.installments
      && payments.every((payment) => matchesGalaticPayment(payment, operation, { installment: order.installments > 1 }))
      && Math.abs(payments.reduce((sum, payment) => sum + Math.round(Number(payment.value) * 100), 0) - pricing.totalCents) <= 1;
    if (!valid) throw Object.assign(new Error("payment_reconciliation_conflict"), { code: "payment_reconciliation_conflict" });
    const payment = [...payments].sort((a, b) => Number(a.installmentNumber ?? 1) - Number(b.installmentNumber ?? 1))[0];
    for (const item of payments) await store.attachPayment(order.id, item.id, normalizeAsaasPaymentStatus(item.status), {
      method: order.method, installments: order.installments, installmentAmountCents: pricing.installmentCents,
      paymentFeeCents: pricing.feeCents, totalCents: pricing.totalCents, providerGroupId: item.installment ?? null,
    });
    const current = await store.getOrderByPublicId(order.id);
    let instructions = null;
    if (order.method === "pix" && current?.status !== "paid") {
      try {
        const qr = await asaasClient.getPixQrCode(payment.id);
        if (qr?.encodedImage && qr?.payload) instructions = { qrCodeBase64: qr.encodedImage, emv: qr.payload, expiresAt: qr.expirationDate ?? null };
      } catch {}
    }
    const response = galaticPaymentResponse(order, pricing, current?.status ?? normalizeAsaasPaymentStatus(payment.status), instructions);
    await store.completeCheckoutAttempt(operation.key, response);
    return response;
  };
}
