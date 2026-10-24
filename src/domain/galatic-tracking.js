const ranks = { label_created: 0, in_transit: 1, out_for_delivery: 2, delivered: 3 };
export function shouldApplyTracking(current, incoming, previousTime = null, incomingTime = null) {
  if (![...Object.keys(ranks), "delivery_exception", "returned", "shipment_canceled"].includes(incoming)) return false;
  if (["delivered", "returned", "shipment_canceled", "canceled"].includes(current)) return incoming === current;
  if (previousTime && incomingTime && Date.parse(incomingTime) < Date.parse(previousTime)) return false;
  if (ranks[current] !== undefined && ranks[incoming] !== undefined && ranks[incoming] < ranks[current]) return false;
  return true;
}
