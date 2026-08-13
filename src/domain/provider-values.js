export function providerId(value, label = "provider id") {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) {
    throw new Error(`Payment provider returned no valid ${label}.`);
  }
  return id;
}

export function optionalProviderId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{6,80}$/.test(id) ? id : null;
}

export function safeAsaasInvoiceUrl(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol === "https:"
      && (hostname === "asaas.com" || hostname.endsWith(".asaas.com"))
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}
