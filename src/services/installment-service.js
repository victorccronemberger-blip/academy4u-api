import {
  customerInstallmentStatus,
  normalizeAsaasPaymentStatus,
  summarizeInstallmentPlan,
} from "../domain/payment-status.js";
import {
  optionalProviderId,
  safeAsaasInvoiceUrl,
} from "../domain/provider-values.js";

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : 0;
}

export function normalizeProviderInstallment(payment) {
  const providerPaymentId = optionalProviderId(payment?.id);
  if (!providerPaymentId) return null;
  const number = Number(payment?.installmentNumber);
  if (!Number.isSafeInteger(number) || number < 1 || number > 60) return null;
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payment?.dueDate ?? ""))
    ? String(payment.dueDate)
    : null;
  const status = normalizeAsaasPaymentStatus(payment?.status);
  return {
    providerPaymentId,
    providerGroupId: optionalProviderId(payment?.installment),
    number,
    status,
    dueDate,
    amountCents: cents(payment?.value),
    paymentUrl: safeAsaasInvoiceUrl(payment?.invoiceUrl),
    paidAt: payment?.paymentDate ?? payment?.clientPaymentDate ?? null,
  };
}

function publicInstallment(row, nextInstallmentNumber) {
  const normalizedStatus = customerInstallmentStatus(row.status, row.dueDate);
  return {
    number: row.number,
    status: normalizedStatus === "scheduled" && row.number === nextInstallmentNumber
      ? "open"
      : normalizedStatus,
    dueDate: row.dueDate,
    amountCents: row.amountCents,
  };
}

export function publicInstallmentPlan(rows, expectedCount = 0) {
  const summary = summarizeInstallmentPlan(rows, expectedCount);
  const installments = (rows ?? [])
    .map((row) => publicInstallment(row, summary.nextInstallmentNumber))
    .sort((left, right) => left.number - right.number);
  return {
    totalInstallments: summary.totalInstallments,
    paidInstallments: summary.paidInstallments,
    remainingInstallments: summary.remainingInstallments,
    nextInstallmentNumber: summary.nextInstallmentNumber,
    nextDueDate: summary.nextDueDate,
    nextInstallmentCents: summary.nextInstallmentCents,
    installments,
  };
}

export function createInstallmentService({ asaasClient, store }) {
  async function sync(order) {
    if (
      !asaasClient
      || typeof asaasClient.listInstallmentPayments !== "function"
      || order?.paymentMethod !== "pix_installment"
      || !order?.providerGroupId
    ) {
      return order?.pixInstallmentPlan ?? null;
    }
    const response = await asaasClient.listInstallmentPayments(order.providerGroupId);
    const rows = Array.isArray(response?.data)
      ? response.data.map(normalizeProviderInstallment).filter(Boolean)
      : [];
    if (!rows.length) return order?.pixInstallmentPlan ?? null;
    await store.replacePaymentInstallments(order.id, order.providerGroupId, rows);
    const stored = await store.listPaymentInstallments(order.id);
    return publicInstallmentPlan(stored, order.installments);
  }

  return Object.freeze({ sync });
}
