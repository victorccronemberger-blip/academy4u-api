import { getCheckoutProduct } from "./catalog.js";
import { normalizeCouponCode, resolveCoupon } from "./coupons.js";

const MAX_CHECKOUT_ITEMS = 20;
const BASIS_POINTS_TOTAL = 10_000;

function applyDiscount(priceCents, discountBps) {
  const discountCents = Math.round((priceCents * discountBps) / BASIS_POINTS_TOTAL);
  return {
    basePriceCents: priceCents,
    discountCents,
    finalPriceCents: priceCents - discountCents,
  };
}

export class CheckoutValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CheckoutValidationError";
    this.code = code;
  }
}

export function createAuthoritativeQuote(input, options = {}) {
  if (!input || typeof input !== "object" || !Array.isArray(input.slugs)) {
    throw new CheckoutValidationError("Carrinho inválido.", "invalid_cart");
  }

  const requested = input.slugs.filter((slug) => typeof slug === "string");
  const slugs = [...new Set(requested)];
  if (!slugs.length || requested.length !== input.slugs.length || slugs.length > MAX_CHECKOUT_ITEMS) {
    throw new CheckoutValidationError("Revise os produtos do carrinho.", "invalid_cart");
  }

  const products = slugs.map(getCheckoutProduct);
  if (products.some((product) => !product)) {
    throw new CheckoutValidationError("Um produto não está disponível para pagamento.", "product_unavailable");
  }

  const normalizedCoupon = normalizeCouponCode(input.couponCode);
  // A repository-backed coupon is passed only by server routes. Client input never
  // controls price or discount metadata.
  const coupon = Object.hasOwn(options, "coupon") ? options.coupon : resolveCoupon(normalizedCoupon);
  if (normalizedCoupon && !coupon) {
    throw new CheckoutValidationError("Cupom inválido ou indisponível.", "invalid_coupon");
  }

  const lines = products.map((product) => ({
    product,
    ...applyDiscount(product.priceCents, coupon?.discountBps ?? 0),
  }));

  return Object.freeze({
    coupon,
    lines,
    subtotalCents: lines.reduce((sum, line) => sum + line.basePriceCents, 0),
    discountCents: lines.reduce((sum, line) => sum + line.discountCents, 0),
    totalCents: lines.reduce((sum, line) => sum + line.finalPriceCents, 0),
  });
}
