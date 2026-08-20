export function createFixedWindowLimiter({
  limit = 12,
  windowMs = 60_000,
  now = () => Date.now(),
  // Aceito pelas rotas para legibilidade da configuração; cada instância tem
  // seu próprio Map de janelas, então o prefixo é apenas documentação.
  prefix: _prefix,
  keyGenerator = (request) => request.ip || "unknown",
} = {}) {
  const windows = new Map();

  return function fixedWindowLimiter(request, response, next) {
    const key = String(keyGenerator(request) || request.ip || "unknown").slice(0, 320);
    const currentTime = now();
    const current = windows.get(key);
    const state = !current || current.resetAt <= currentTime
      ? { count: 0, resetAt: currentTime + windowMs }
      : current;
    state.count += 1;
    windows.set(key, state);

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

    if (windows.size > 2_000) {
      for (const [candidate, value] of windows) {
        if (value.resetAt <= currentTime) windows.delete(candidate);
      }
    }
    next();
  };
}
