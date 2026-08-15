import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";

export function createGalaticPaymentMaintenance({ environment, store, asaasClient, notifications = null, clock = () => Date.now() }) {
  let running = false;
  let interval = null;
  let initial = null;

  async function notifyCanceled(orderId) {
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
    if (running || !environment.galaticPaymentMaintenanceEnabled || !asaasClient) return { skipped: true };
    running = true;
    const result = { inspected: 0, canceled: 0, paid: 0, failed: 0 };
    try {
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
    } finally {
      running = false;
    }
  }

  function start() {
    if (interval || !environment.galaticPaymentMaintenanceEnabled || !asaasClient) return;
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
