const TENANT_ID = /^[a-z][a-z0-9-]{1,31}$/;

function unique(values) {
  return [...new Set(values)];
}

function variablePrefix(tenantId) {
  return tenantId.replace(/-/g, "_").toUpperCase();
}

function origin(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTPS origin without path, query or credentials.`);
  }
  return parsed.origin;
}

function secret(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function getTenantDefinitions(source, legacyEnvironment) {
  const configured = String(source.PAYMENT_TENANTS ?? "academy4u")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const ids = unique(configured);
  if (!ids.length || ids.some((id) => !TENANT_ID.test(id))) {
    throw new Error("PAYMENT_TENANTS must contain valid comma-separated tenant identifiers.");
  }

  return ids.map((id, index) => {
    const prefix = variablePrefix(id);
    const isLegacyDefault = index === 0 && id === "academy4u";
    const publicOrigin = origin(
      source[`${prefix}_PUBLIC_ORIGIN`]
        ?? (isLegacyDefault ? legacyEnvironment.publicOrigin : null),
      `${prefix}_PUBLIC_ORIGIN`,
    );
    const mysqlUrl = secret(
      source[`${prefix}_MYSQL_URL`]
        ?? (isLegacyDefault ? legacyEnvironment.mysqlUrl : null),
    );
    const trustedCheckoutToken = secret(
      source[`${prefix}_TRUSTED_CHECKOUT_TOKEN`]
        ?? (isLegacyDefault ? legacyEnvironment.trustedCheckoutToken : null),
    );
    const referencePrefix = String(
      source[`${prefix}_PAYMENT_REFERENCE_PREFIX`]
        ?? (id === "academy4u" ? "academy" : id),
    ).trim().toLowerCase();

    if (!publicOrigin) throw new Error(`${prefix}_PUBLIC_ORIGIN is required.`);
    if (!mysqlUrl && legacyEnvironment.nodeEnvironment === "production") {
      throw new Error(`${prefix}_MYSQL_URL is required in production.`);
    }
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(referencePrefix)) {
      throw new Error(`${prefix}_PAYMENT_REFERENCE_PREFIX is invalid.`);
    }

    return Object.freeze({
      id,
      variablePrefix: prefix,
      publicOrigin,
      mysqlUrl,
      trustedCheckoutToken,
      referencePrefix,
      isDefault: index === 0,
    });
  });
}

export function assertTenantIsolation(tenants) {
  const origins = tenants.map((tenant) => tenant.publicOrigin);
  const references = tenants.map((tenant) => tenant.referencePrefix);
  if (new Set(origins).size !== origins.length) {
    throw new Error("Each payment tenant must use a distinct public origin.");
  }
  if (new Set(references).size !== references.length) {
    throw new Error("Each payment tenant must use a distinct payment reference prefix.");
  }
  const databaseUrls = tenants.map((tenant) => tenant.mysqlUrl).filter(Boolean);
  if (new Set(databaseUrls).size !== databaseUrls.length) {
    throw new Error("Each payment tenant must use an independent MySQL database.");
  }
  return tenants;
}
