export function normalizeCouponCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  return normalized || null;
}

/** Cupons são resolvidos exclusivamente pelo repositório persistente. */
export function resolveCoupon() {
  return null;
}
