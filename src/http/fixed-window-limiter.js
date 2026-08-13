export function createFixedWindowLimiter({
  limit = 12,
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const windows = new Map();

  return function fixedWindowLimiter(request, response, next) {
    const key = request.ip || "unknown";
    const currentTime = now();
    const current = windows.get(key);
    const state = !current || current.resetAt <= currentTime
      ? { count: 0, resetAt: currentTime + windowMs }
      : current;
    state.count += 1;
    windows.set(key, state);

    if (state.count > limit) {
      response.set("Retry-After", String(Math.ceil((state.resetAt - currentTime) / 1_000)));
      response.status(429).json({
        error: "rate_limited",
        message: "Muitas tentativas. Aguarde um instante antes de tentar novamente.",
      });
      return;
    }

    if (windows.size > 2_000) {
      for (const [candidate, value] of windows) {
        if (value.resetAt <= currentTime) windows.delete(candidate);
      }
    }
    next();
  };
}
