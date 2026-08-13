import { createAuthoritativeQuote, CheckoutValidationError } from "../domain/quote.js";
import { normalizeCouponCode } from "../domain/coupons.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

export function createPublicCommerceRouter(express, { store }) {
  const router = express.Router();
  const limiter = createFixedWindowLimiter();

  router.get("/products", async (_request, response) => {
    response.json({ products: await store.listCatalogProducts() });
  });

  router.post("/quote", limiter, async (request, response) => {
    try {
      const slugs = request.body?.slugs;
      const code = normalizeCouponCode(request.body?.couponCode);
      const stored = code && Array.isArray(slugs)
        ? await store.getEligibleCoupon(code, [...new Set(slugs)])
        : null;
      const quote = createAuthoritativeQuote({ slugs, couponCode: code }, { coupon: stored });
      response.json({
        coupon: quote.coupon ? { code: quote.coupon.code, discountBps: quote.coupon.discountBps } : null,
        lines: quote.lines.map((line) => ({
          slug: line.product.slug,
          title: line.product.title,
          basePriceCents: line.basePriceCents,
          discountCents: line.discountCents,
          finalPriceCents: line.finalPriceCents,
        })),
        subtotalCents: quote.subtotalCents,
        discountCents: quote.discountCents,
        totalCents: quote.totalCents,
      });
    } catch (error) {
      const status = error instanceof CheckoutValidationError ? 400 : 500;
      response.status(status).json({ error: error.code ?? "quote_unavailable", message: error.message });
    }
  });

  return router;
}
