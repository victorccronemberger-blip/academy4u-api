const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function enforceHttps(nodeEnvironment) {
  return function httpsOnly(request, response, next) {
    if (nodeEnvironment !== "production") return next();
    const protocol = String(request.get("x-forwarded-proto") ?? request.protocol).split(",", 1)[0].trim();
    if (protocol === "https") return next();
    response.set("Upgrade", "TLS/1.2, HTTP/1.1");
    return response.status(426).json({
      error: "https_required",
      message: "Esta API aceita somente conexões HTTPS.",
    });
  };
}

export function rejectUnsupportedBodies(request, response, next) {
  if (!BODY_METHODS.has(request.method)) return next();
  const length = Number(request.get("content-length") ?? 0);
  const type = String(request.get("content-type") ?? "").toLowerCase();
  if (!length) return next();
  if (type.startsWith("application/json")) return next();
  return response.status(415).json({
    error: "unsupported_media_type",
    message: "Esta API aceita somente corpos JSON; uploads de arquivos não são permitidos.",
  });
}

export function privateResponseHeaders(_request, response, next) {
  response.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "X-Permitted-Cross-Domain-Policies": "none",
  });
  next();
}

export function allowBodyFields(fields) {
  const allowed = new Set(fields);
  return function strictBody(request, response, next) {
    const body = request.body;
    if (!body || Array.isArray(body) || typeof body !== "object") return next();
    const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
    if (!unexpected.length) return next();
    return response.status(400).json({
      error: "unexpected_fields",
      message: "A solicitação contém campos que não são aceitos.",
      fields: unexpected.slice(0, 8),
    });
  };
}
