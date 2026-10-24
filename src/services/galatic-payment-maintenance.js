import { closedGalaticFinancialGate } from "./galatic-financial-gate.js";
import { createGalaticNotificationOutbox } from "./galatic-notification-outbox.js";
import { createGalaticPaymentRecovery } from "./galatic-payment-recovery.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";

export function createGalaticPaymentMaintenance({ environment, store, asaasClient, notifications = null, clock = () => Date.now(), financialGate = closedGalaticFinancialGate }) {
  const recoverPayment = store.getCheckoutRecovery ? createGalaticPaymentRecovery({ store, asaasClient, financialGate }) : null;
  const processOutbox = createGalaticNotificationOutbox({ store, notifications });
  let running = false;
  let interval = null;
  let initial = null;

  async function notifyCanceled(orderId) {
    if (store.enqueueNotification) return; // committed with cancellation
    if (!notifications?.sendPaymentCanceled || !store.getOrderNotification) return;
    const order = await store.getOrderNotification(orderId);
    const key = `payment-expired:${orderId}`;
    if (!order || !(await store.claimNotification?.(key))) return;
    notifications.sendPaymentCanceled(order).catch(async () => {
      await store.releaseNotification?.(key).catch(() => {});
    });
  }

  async function reconcile(order) {
    if (!order.providerOrderId) {
      const operation = await store.getCheckoutRecovery?.({ orderId: order.id });
      if (operation && ["creating", "uncertain", "attached"].includes(operation.state)) {
        const recovered = await recoverPayment({ orderId: order.id });
        return recovered?.body?.status ?? "uncertain";
      }
      await store.adminCancelUnpaidOrder(order.id);
      await notifyCanceled(order.id);
      return "canceled";
    }
    let payment;
    try {
      payment = await asaasClient.getPayment(order.providerOrderId);
    } catch (error) {
      if (error?.status !== 404) throw error;
      await store.adminCancelUnpaidOrder(order.id);
      await notifyCanceled(order.id);
      return "canceled";
    }
    const status = normalizeAsaasPaymentStatus(payment?.status);
    if (status === "paid") {
      await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: order.providerOrderId, status: "paid" });
      return "paid";
    }
    if (["refunded", "chargeback"].includes(status)) {
      await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: order.providerOrderId, status });
      return status;
    }
    if (status !== "canceled") {
      try {
        if (order.providerGroupId) await asaasClient.deleteInstallment(order.providerGroupId);
        else await asaasClient.deletePayment(order.providerOrderId);
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    await store.adminCancelUnpaidOrder(order.id);
    await notifyCanceled(order.id);
    return "canceled";
  }

  async function run() {
    if (running) return { skipped: true };
    running = true;
    const result = { inspected: 0, canceled: 0, paid: 0, failed: 0 };
    try {
      await processOutbox();
      if (!financialGate.enabled || !environment.galaticPaymentMaintenanceEnabled || !asaasClient) return { ...result, skippedPayments: true };
      return await financialGate.run(async () => {
        if (recoverPayment && store.claimPaymentReconciliations) {
          for (const operation of await store.claimPaymentReconciliations()) {
            try { await recoverPayment({ key: operation.key }); }
            catch (error) {
              result.failed += 1;
              await store.recordPaymentReconciliationError?.(operation.key, error?.code ?? error?.name);
              await store.recordOperationalAlert?.({ type: "payment_reconciliation_required", source: "galatic-payment-maintenance",
                summary: "Tentativa financeira exige conciliacao; reserva e chave preservadas.",
                context: { orderId: operation.orderId, code: error?.code ?? error?.name } });
            }
          }
        }
        for (const refund of await store.claimRefundReconciliations?.() ?? []) {
          try {
            const payments = refund.providerGroupId
              ? (await asaasClient.listInstallmentPayments(refund.providerGroupId))?.data
              : [await asaasClient.getPayment(refund.providerOrderId)];
            if (!Array.isArray(payments) || payments.length !== refund.installments
              || payments.some((payment) => normalizeAsaasPaymentStatus(payment.status) !== "refunded")) {
              await store.recordRefundReconciliationError?.(refund.id, "refund_not_yet_confirmed", refund.version);
              continue;
            }
            await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: refund.providerOrderId,
              providerGroupId: refund.providerGroupId, status: "refunded" });
          } catch (error) { await store.recordRefundReconciliationError?.(refund.id, error?.code ?? error?.name, refund.version); }
        }
        const now = clock();
        const orders = await store.listExpiredPaymentReservations({
          pixBefore: new Date(now - environment.galaticPixReservationMinutes * 60_000),
          cardBefore: new Date(now - environment.galaticCardReservationMinutes * 60_000),
          limit: 50,
        });
        for (const order of orders) {
          result.inspected += 1;
          try {
            const status = await reconcile(order);
            if (status === "paid") result.paid += 1;
            else if (status === "canceled") result.canceled += 1;
          } catch (error) {
            result.failed += 1;
            await store.recordOperationalAlert?.({ type: "payment_maintenance_failure", source: "galatic-payment-maintenance",
              summary: "Falha ao reconciliar reserva de estoque expirada.",
              context: { orderId: order.id, errorType: error?.name ?? "Error", code: error?.code ?? null } }).catch(() => {});
          }
        }
        return result;
      });
    } finally {
      running = false;
    }
  }

  function start() {
    if (interval) return;
    initial = setTimeout(() => run().catch(() => {}), 30_000);
    initial.unref?.();
    interval = setInterval(() => run().catch(() => {}), 5 * 60_000);
    interval.unref?.();
  }

  function stop() {
    if (initial) clearTimeout(initial);
    if (interval) clearInterval(interval);
    initial = null;
    interval = null;
  }

  return Object.freeze({ run, start, stop });
}
