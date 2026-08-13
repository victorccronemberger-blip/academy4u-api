const TERMINAL_STATUSES = new Set(["refunded", "chargeback"]);
const PRE_PAYMENT_RANK = new Map([
  ["created", 0],
  ["open", 1],
  ["processing", 2],
  ["overdue", 3],
]);

export function resolveOrderStatus(currentStatus, incomingStatus) {
  const current = String(currentStatus ?? "").trim().toLowerCase();
  const incoming = String(incomingStatus ?? "").trim().toLowerCase();

  if (!current) return incoming || "processing";
  if (!incoming || current === incoming) return current;
  if (TERMINAL_STATUSES.has(current)) return current;
  if (current === "paid") {
    return TERMINAL_STATUSES.has(incoming) ? incoming : current;
  }
  if (incoming === "paid" || TERMINAL_STATUSES.has(incoming)) return incoming;
  if (current === "failed") return current;
  if (incoming === "failed") return incoming;
  if (PRE_PAYMENT_RANK.has(current) && PRE_PAYMENT_RANK.has(incoming)) {
    return PRE_PAYMENT_RANK.get(incoming) >= PRE_PAYMENT_RANK.get(current) ? incoming : current;
  }
  return current;
}
