import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createAsaasClient } from "../integrations/asaas/client.js";
import { closedGalaticFinancialGate } from "./galatic-financial-gate.js";

export const PROFILE_VERIFICATION_TTL_MS = 15 * 60_000;
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const ENV_NAME = /^GALATIC_[A-Z0-9_]+$/;
const WALLET = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ORIGINS = Object.freeze({ sandbox: "https://api-sandbox.asaas.com/v3", production: "https://api.asaas.com/v3" });
export const paymentProfileError = (code) => Object.assign(new Error(code), { code, status: 503 });
export function paymentNamespace(profileId) {
  if (profileId === null || profileId === undefined) return "legacy";
  if (!ID.test(profileId)) throw paymentProfileError("payment_profile_invalid");
  return `profile:${profileId}`;
}
export function paymentBinding(row) {
  const profileId = row?.profileId ?? row?.payment_profile_id ?? null;
  return Object.freeze({ profileId, namespace: paymentNamespace(profileId) });
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? "")); const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}
export function profileIdentity(entry) {
  return Object.freeze({ id: entry.id, provider: entry.provider, environment: entry.environment,
    expectedWalletId: entry.expectedWalletId, allowedTenants: Object.freeze([...entry.allowedTenants].sort()) });
}
export function profileIdentityHash(entry) {
  return createHash("sha256").update(JSON.stringify(profileIdentity(entry))).digest("hex");
}
export function assertWalletIdentity(result, expected) {
  if (result?.object !== "list" || result.hasMore !== false || result.totalCount !== 1
    || !Number.isInteger(result.offset) || result.offset !== 0 || !Number.isInteger(result.limit) || result.limit < 1
    || !Array.isArray(result.data) || result.data.length !== 1 || result.data[0]?.object !== "wallet"
    || !WALLET.test(result.data[0]?.id ?? "") || result.data[0].id !== expected) {
    throw paymentProfileError("payment_profile_wallet_mismatch");
  }
}

// Galatic clients capture credentials and origins; none inherit Academy's
// mutable LMS runtime configuration. Secret values stay in this closure.
export function createGalaticPaymentProfiles({ source = {}, store, financialGate = closedGalaticFinancialGate,
  legacyWebhookAuthentication = {}, createClient = createAsaasClient, clock = () => Date.now(), verificationTtlMs = PROFILE_VERIFICATION_TTL_MS } = {}) {
  const profiles = new Map(); const verified = new Map(); const verifying = new Map();
  const defaultId = source.GALATIC_DEFAULT_PAYMENT_PROFILE_ID ?? null;
  let configurationError = null; let initialized = false;
  try {
    const entries = JSON.parse(source.GALATIC_PAYMENT_PROFILES_JSON ?? "[]");
    if (!Array.isArray(entries)) throw paymentProfileError("payment_profile_configuration_invalid");
    const tokenOwners = new Map();
    const legacyTokens = [source.ASAAS_WEBHOOK_TOKEN, source.ASAAS_SANDBOX_WEBHOOK_TOKEN].filter(Boolean).map((token) => token.trim());
    for (const entry of entries) {
      if (!ID.test(entry?.id ?? "") || profiles.has(entry.id) || entry.provider !== "asaas"
        || !ORIGINS[entry.environment] || !WALLET.test(entry.expectedWalletId ?? "")
        || !Array.isArray(entry.allowedTenants) || entry.allowedTenants.length !== 1 || entry.allowedTenants[0] !== "galatic"
        || !ENV_NAME.test(entry.apiKeyEnv ?? "") || !ENV_NAME.test(entry.webhookTokenEnv ?? "")
        || (entry.previousWebhookTokenEnv && !ENV_NAME.test(entry.previousWebhookTokenEnv))) {
        throw paymentProfileError("payment_profile_configuration_invalid");
      }
      const tokens = [source[entry.webhookTokenEnv], entry.previousWebhookTokenEnv ? source[entry.previousWebhookTokenEnv] : undefined]
        .filter((token) => token !== undefined && token !== null && token !== "");
      if (tokens.some((token) => typeof token !== "string" || !/^[\x21-\x7e]{1,200}$/.test(token))) {
        throw paymentProfileError("payment_profile_webhook_invalid");
      }
      for (const token of tokens) {
        if (legacyTokens.some((legacy) => safeEqual(token, legacy))
          || (legacyWebhookAuthentication.asaasWebhookTokenHash && safeEqual(createHash("sha256").update(token).digest("hex"), legacyWebhookAuthentication.asaasWebhookTokenHash))) throw paymentProfileError("payment_profile_webhook_ambiguous");
        if (tokenOwners.has(token) && tokenOwners.get(token) !== entry.id) throw paymentProfileError("payment_profile_webhook_ambiguous");
        tokenOwners.set(token, entry.id);
      }
      const key = source[entry.apiKeyEnv];
      const snapshot = Object.freeze({ asaasAvailable: typeof key === "string" && key.length > 0,
        asaasApiKey: key, asaasApiOrigin: ORIGINS[entry.environment], asaasEnvironment: entry.environment });
      profiles.set(entry.id, Object.freeze({ identity: profileIdentity(entry), identityHash: profileIdentityHash(entry),
        tokens: Object.freeze(tokens), snapshot, generation: randomUUID(), client: createClient(snapshot, undefined, entry.id) }));
    }
  } catch (error) { configurationError = error?.code ?? "payment_profile_configuration_invalid"; profiles.clear(); }

  function resolveBoundProfile(binding) {
    if (configurationError) throw paymentProfileError(configurationError);
    const id = paymentBinding(binding).profileId;
    if (!id) throw paymentProfileError("payment_profile_unknown");
    const profile = profiles.get(id);
    if (!profile || !initialized) throw paymentProfileError("payment_profile_unavailable");
    return profile;
  }
  async function verifyProfile(id) {
    financialGate.assertEnabled();
    const profile = resolveBoundProfile({ profileId: id });
    if (verifying.has(id)) return verifying.get(id);
    const pending = (async () => {
      verified.delete(id);
      if (!profile.client?.getWallets) throw paymentProfileError("payment_profile_credentials_unavailable");
      assertWalletIdentity(await profile.client.getWallets(), profile.identity.expectedWalletId);
      verified.set(id, clock() + verificationTtlMs);
    })().finally(() => verifying.delete(id));
    verifying.set(id, pending); return pending;
  }
  async function authorize(profile, capability) {
    financialGate.assertEnabled();
    if (!(verified.get(profile.identity.id) > clock())) throw paymentProfileError("payment_profile_verification_expired");
    if (capability === "checkout" && profile.tokens.length === 0) throw paymentProfileError("payment_profile_webhook_unconfigured");
    const authorization = await store.getPaymentProfileAuthorization(profile.identity.id);
    if (!Array.isArray(authorization?.capabilities) || !authorization.capabilities.includes(capability)) throw paymentProfileError("payment_profile_capability_denied");
    if (profile.identity.environment === "production" && (authorization.commercialApproved !== true
      || typeof authorization.evidenceReference !== "string" || !authorization.evidenceReference.trim())) {
      throw paymentProfileError("payment_profile_commercial_approval_required");
    }
    await store.assertPaymentProfileDispatchPhase();
    return authorization;
  }
  async function getVerifiedClient(binding, capability) {
    const profile = resolveBoundProfile(binding);
    const authorization = await authorize(profile, capability);
    const client = Object.freeze(Object.fromEntries(Object.entries(profile.client).filter(([, method]) => typeof method === "function").map(([name, method]) =>
      [name, async (...args) => { await authorize(profile, capability); return method(...args); }])));
    return Object.freeze({ client, profileId: profile.identity.id, namespace: paymentNamespace(profile.identity.id),
      generation: profile.generation, environment: profile.identity.environment, commercialApproved: authorization.commercialApproved === true });
  }
  async function initialize() {
    if (configurationError) return;
    for (const profile of profiles.values()) {
      try { await store.registerPaymentProfileIdentity(profile.identity, profile.identityHash); }
      catch { configurationError = "payment_profile_identity_conflict"; return; }
    }
    initialized = true;
    if (financialGate.enabled) await Promise.allSettled([...profiles.keys()].map(verifyProfile));
  }
  async function resolveNewOrderProfile(tenant = "galatic") {
    if (tenant !== "galatic" || !defaultId) throw paymentProfileError("payment_profile_unconfigured");
    return getVerifiedClient({ profileId: defaultId }, "checkout");
  }
  function authenticateProfileWebhook(id, credential) {
    const profile = resolveBoundProfile({ profileId: id });
    if (!profile.tokens.length) throw paymentProfileError("payment_profile_webhook_unconfigured");
    if (!credential || !profile.tokens.some((token) => safeEqual(token, credential))) {
      throw Object.assign(new Error("invalid_webhook_token"), { code: "invalid_webhook_token", status: 401 });
    }
    return Object.freeze({ profileId: id, namespace: paymentNamespace(id), tenantId: "galatic" });
  }
  async function getPaymentReadiness() {
    const profile = profiles.get(defaultId);
    let profileStatus = configurationError ? "invalid" : !profile ? "unconfigured" : !initialized ? "initializing"
      : !(verified.get(defaultId) > clock()) ? "unverified" : "verified";
    let checkoutAvailable = false;
    let commercialApproval = false;
    if (profile && initialized && !configurationError) {
      try { const authorization = await store.getPaymentProfileAuthorization(defaultId); commercialApproval = authorization?.commercialApproved === true && Boolean(authorization.evidenceReference); } catch {}
    }
    if (profileStatus === "verified" && financialGate.enabled) {
      try { await getVerifiedClient({ profileId: defaultId }, "checkout"); checkoutAvailable = true; }
      catch (error) { profileStatus = error.code === "payment_profile_cutover_required" ? "migration_required" : "restricted"; }
    }
    return { profileStatus, paymentEnvironment: configurationError ? null : profile?.identity.environment ?? null, checkoutAvailable, commercialApproval, approvalScope: "recorded_operational_review" };
  }
  return Object.freeze({ initialize, verifyProfile, resolveBoundProfile, getVerifiedClient, resolveNewOrderProfile,
    authenticateProfileWebhook, getPaymentReadiness });
}
