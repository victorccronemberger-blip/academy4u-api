const PROVIDER_ID = /^[A-Za-z0-9_-]{6,80}$/;
const KNOWN_STATUSES = new Set(["PENDING", "OVERDUE", "RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH", "REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL", "AWAITING_RISK_ANALYSIS"]);
const TERMINAL_EVIDENCE = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH", "REFUNDED", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"]);

export function validGalaticProviderPayment(payment, { allowDeletedTerminal = false } = {}) {
  return Boolean(payment && !Array.isArray(payment) && typeof payment === "object"
    && typeof payment.id === "string" && PROVIDER_ID.test(payment.id)
    && typeof payment.customer === "string" && PROVIDER_ID.test(payment.customer)
    && typeof payment.externalReference === "string" && payment.externalReference.length <= 100
    && ["PIX", "CREDIT_CARD"].includes(payment.billingType)
    && typeof payment.value === "number" && Number.isFinite(payment.value) && payment.value > 0
    && typeof payment.status === "string" && KNOWN_STATUSES.has(payment.status)
    && (payment.deleted === undefined || typeof payment.deleted === "boolean")
    && (!payment.deleted || (allowDeletedTerminal && TERMINAL_EVIDENCE.has(payment.status)))
    && (payment.installment === undefined || payment.installment === null
      || (typeof payment.installment === "string" && PROVIDER_ID.test(payment.installment)))
    && (payment.installmentNumber === undefined || (Number.isInteger(payment.installmentNumber) && payment.installmentNumber >= 1 && payment.installmentNumber <= 10))
    && (payment.refundedValue === undefined || (typeof payment.refundedValue === "number" && Number.isFinite(payment.refundedValue) && payment.refundedValue >= 0))
    && (payment.refunds === undefined || (Array.isArray(payment.refunds) && payment.refunds.every((refund) => refund && typeof refund === "object" && !Array.isArray(refund)))));
}

export function completeGalaticPaymentList(result, expectedCount) {
  return Boolean(result && !Array.isArray(result) && typeof result === "object" && result.hasMore === false
    && (result.object === undefined || result.object === "list") && Array.isArray(result.data) && result.data.length === expectedCount
    && (result.totalCount === undefined || (Number.isInteger(result.totalCount) && result.totalCount === expectedCount))
    && (result.offset === undefined || result.offset === 0)
    && (result.limit === undefined || (Number.isInteger(result.limit) && result.limit >= Math.max(1, expectedCount))));
}

export function matchesGalaticPayment(payment, { order, pricing, providerCustomerId }, { installment = false, allowDeletedTerminal = false } = {}) {
  if (!validGalaticProviderPayment(payment, { allowDeletedTerminal }) || !pricing || !Number.isSafeInteger(pricing.totalCents) || pricing.totalCents <= 0
      || typeof providerCustomerId !== "string" || !PROVIDER_ID.test(providerCustomerId)
      || !["pix", "credit_card"].includes(order?.method) || !Number.isInteger(order.installments) || order.installments < 1 || order.installments > 10
      || (order.method === "pix" && order.installments !== 1)
      || payment.externalReference !== `galatic:${order.id}` || payment.customer !== providerCustomerId
      || payment.billingType !== (order.method === "pix" ? "PIX" : "CREDIT_CARD")) return false;
  const cents = Math.round(payment.value * 100);
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
