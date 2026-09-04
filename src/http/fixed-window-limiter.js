import { createHash } from "node:crypto";

export function createFixedWindowLimiter({
  limit = 12,
  windowMs = 60_000,
  now = () => Date.now(),
  prefix = "http",
  consume = null,
  keyGenerator = (request) => request.ip || "unknown",
} = {}) {
  const windows = new Map();

  return async function fixedWindowLimiter(request, response, next) {
    const key = String(keyGenerator(request) || request.ip || "unknown").slice(0, 320);
    const currentTime = now();
    let state;
    try {
      if (consume) {
        state = await consume({ scope: prefix, keyHash: createHash("sha256").update(key).digest("hex"),
          limit, windowMs, nowMs: currentTime });
      } else {
        const current = windows.get(key);
        state = !current || current.resetAt <= currentTime ? { count: 0, resetAt: currentTime + windowMs } : current;
        state.count += 1;
        windows.set(key, state);
      }
    } catch (error) { return next(error); }

    response.set({
      "RateLimit-Limit": String(limit),
      "RateLimit-Remaining": String(Math.max(0, limit - state.count)),
      "RateLimit-Reset": String(Math.ceil(state.resetAt / 1_000)),
    });

    if (state.count > limit) {
      response.set("Retry-After", String(Math.ceil((state.resetAt - currentTime) / 1_000)));
      response.status(429).json({
        error: "rate_limited",
        message: "Muitas tentativas. Aguarde um instante antes de tentar novamente.",
      });
      return;
    }

    if (!consume && windows.size > 2_000) {
      for (const [candidate, value] of windows) {
        if (value.resetAt <= currentTime) windows.delete(candidate);
      }
    }
    next();
  };
}
