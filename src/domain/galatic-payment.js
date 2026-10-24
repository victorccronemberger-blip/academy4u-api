export function matchesGalaticPayment(payment, { order, pricing, providerCustomerId }, { installment = false } = {}) {
  if (!payment?.id || !pricing || !providerCustomerId || payment.deleted
      || payment.externalReference !== `galatic:${order.id}` || payment.customer !== providerCustomerId
      || payment.billingType !== (order.method === "pix" ? "PIX" : "CREDIT_CARD")) return false;
  const value = Number(payment.value);
  if (!Number.isFinite(value) || value <= 0) return false;
  const cents = Math.round(value * 100);
  if (order.installments === 1) return !payment.installment && cents === pricing.totalCents;
  return Boolean(payment.installment) && installment
    && Math.abs(cents - pricing.totalCents / order.installments) <= order.installments;
}

export function galaticPaymentResponse(order, pricing, status, instructions = null) {
  return { status: 201, body: { orderId: order.id, status, method: order.method,
    installments: order.installments, installmentCents: pricing.installmentCents, cardFeeCents: pricing.feeCents,
    subtotalCents: order.subtotalCents, shippingCents: order.shippingCents, discountCents: order.discountCents ?? 0,
    couponCode: order.couponCode ?? null, baseTotalCents: pricing.baseCents, totalCents: pricing.totalCents,
    ...(order.method === "pix" ? (instructions ? { pix: instructions } : { pixPending: true })
      : { message: status === "paid" ? "Pagamento aprovado." : "Pagamento recebido e em análise." }) } };
}
