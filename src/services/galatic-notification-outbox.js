export function createGalaticNotificationOutbox({ store, notifications }) {
  return async function run() {
    if (!store.claimNotificationJobs || !notifications?.ready) return { skipped: true };
    const result = { sent: 0, failed: 0 };
    for (const job of await store.claimNotificationJobs()) {
      try {
        const order = await store.getOrderNotification(job.orderId);
        if (!order || typeof notifications[job.method] !== "function") throw new Error("notification_unavailable");
        await notifications[job.method]({ ...order, ...job.details });
        await store.completeNotificationJob(job.key, job.lease);
        result.sent += 1;
      } catch (error) {
        await store.failNotificationJob(job.key, job.lease, error?.code ?? error?.name);
        result.failed += 1;
      }
    }
    return result;
  };
}
