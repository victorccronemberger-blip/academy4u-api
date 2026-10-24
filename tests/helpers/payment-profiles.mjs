import { createApp as createActualApp } from "../../src/application.js";
import { createGalaticPaymentProfiles } from "../../src/services/galatic-payment-profiles.js";
import { createGalaticFinancialGate } from "../../src/services/galatic-financial-gate.js";
import { createGalaticPaymentMaintenance as maintenance } from "../../src/services/galatic-payment-maintenance.js";
import { createGalaticPaymentRecovery as recovery } from "../../src/services/galatic-payment-recovery.js";
import { createGalaticFulfillmentService as fulfillment } from "../../src/services/galatic-fulfillment.js";

export const PROFILE_ID = "galatic-synthetic";
export const CUSTOMER_ID = "cus_profile_fixture";
export const WALLET_ID = "11111111-1111-4111-8111-111111111111";
export const walletResponse = { object: "list", totalCount: 1, hasMore: false, offset: 0, limit: 10,
  data: [{ object: "wallet", id: WALLET_ID }] };
export function syntheticAction({ id, providerOrderId = "pay_owned", providerGroupId = null, installments = 1,
  method = installments > 1 ? "credit_card" : "pix", totalCents = 10000, providerCustomerId = CUSTOMER_ID, ...rest }) {
  return { profileId: PROFILE_ID, id, providerOrderId, providerGroupId, installments, method, totalCents, providerCustomerId,
    pricing: { totalCents, baseCents: totalCents, feeCents: 0, installmentCents: Math.ceil(totalCents / installments) }, ...rest };
}
export function syntheticPayment(snapshot, status = "CONFIRMED", index = 1) {
  return { id: index === 1 ? snapshot.providerOrderId : `${snapshot.providerOrderId}_${index}`, customer: snapshot.providerCustomerId,
    billingType: snapshot.method === "pix" ? "PIX" : "CREDIT_CARD", value: snapshot.totalCents / 100 / snapshot.installments,
    externalReference: `galatic:${snapshot.id}`, status, ...(snapshot.providerGroupId ? { installment: snapshot.providerGroupId, installmentNumber: index } : {}) };
}
export function addSyntheticOrderProof(store, snapshot) {
  store.getCheckoutRecovery = async () => ({ profileId: snapshot.profileId, order: snapshot, pricing: snapshot.pricing, providerCustomerId: snapshot.providerCustomerId });
  store.claimBoundAction = async ({ kind }) => ({ claimed: true, ...snapshot, group: Boolean(snapshot.providerGroupId),
    providerReference: snapshot.providerGroupId || snapshot.providerOrderId, referenceKind: snapshot.providerGroupId ? "installment" : "payment", version: 1, kind });
  store.finishCancellationRequest = async () => {};
  return { getPayment: async () => syntheticPayment(snapshot), listInstallmentPayments: async () => ({ hasMore: false,
    totalCount: snapshot.installments, data: Array.from({ length: snapshot.installments }, (_, i) => syntheticPayment(snapshot, "CONFIRMED", i + 1)) }) };
}
export function profileSource(environment = "sandbox") {
  return { GALATIC_PAYMENT_PROFILES_JSON: JSON.stringify([{ id: PROFILE_ID, provider: "asaas", environment,
    expectedWalletId: WALLET_ID, allowedTenants: ["galatic"], apiKeyEnv: "GALATIC_SYNTHETIC_KEY", webhookTokenEnv: "GALATIC_SYNTHETIC_TOKEN" }]),
    GALATIC_DEFAULT_PAYMENT_PROFILE_ID: PROFILE_ID, GALATIC_SYNTHETIC_KEY: "synthetic-profile-key", GALATIC_SYNTHETIC_TOKEN: "synthetic-profile-token" };
}
const decorated = new WeakSet();
export function profileStore(store) {
  if (decorated.has(store)) return store;
  decorated.add(store);
  const identities = new Map(); const claims = new Set();
  store.registerPaymentProfileIdentity ??= async (identity, hash) => {
    if (identities.has(identity.id) && identities.get(identity.id) !== hash) throw new Error("identity_conflict");
    identities.set(identity.id, hash);
  };
  store.getPaymentProfileAuthorization ??= async () => ({ capabilities: ["checkout", "read", "recovery", "refund", "cancel", "webhook", "fulfillment"],
    commercialApproved: true, evidenceReference: "synthetic-reviewed-merchant" });
  store.assertPaymentProfileDispatchPhase ??= async () => {};
  store.claimExternalOperation ??= async ({ orderId, operation }) => {
    const key = `${orderId}:${operation}`;
    if (claims.has(key)) throw Object.assign(new Error("payment_operation_already_started"), { code: "payment_operation_already_started" });
    claims.add(key); return key;
  };
  store.finishExternalOperation ??= async () => {};
  if (store.prepareOrder) {
    const original = store.prepareOrder.bind(store);
    store.prepareOrder = async (input) => {
      const result = await original(input);
      return result?.order ? { ...result, order: { profileId: input.profileId, ...result.order } } : result;
    };
  }
  for (const method of ["getOrderByPublicId", "adminPaymentContext"]) if (store[method]) {
    const original = store[method].bind(store);
    store[method] = async (...args) => { const value = await original(...args); return value ? { profileId: PROFILE_ID, ...value } : value; };
  }
  if (store.getCheckoutRecovery) {
    const original = store.getCheckoutRecovery.bind(store);
    store.getCheckoutRecovery = async (...args) => {
      const value = await original(...args);
      return value ? { profileId: PROFILE_ID, ...value, order: { profileId: PROFILE_ID, ...value.order } } : value;
    };
  }
  return store;
}
export function syntheticProfiles(store, client, environment = "sandbox", financialGate = createGalaticFinancialGate({ enabled: true })) {
  profileStore(store);
  const registry = createGalaticPaymentProfiles({ source: profileSource(environment), store, financialGate,
    createClient: () => client ? Object.freeze({ ...client, getWallets: async () => structuredClone(walletResponse) }) : null });
  const initialized = registry.initialize();
  return { ...registry, getVerifiedClient: async (...args) => { await initialized; return registry.getVerifiedClient(...args); },
    resolveNewOrderProfile: async (...args) => { await initialized; return registry.resolveNewOrderProfile(...args); } };
}
export function createApp(source = {}, dependencies = {}) {
  const store = dependencies.stores?.galatic ?? (source.PAYMENT_TENANTS === "galatic" ? dependencies.store : null);
  if (!store) return createActualApp(source, dependencies);
  profileStore(store);
  return createActualApp({ ...source, ...profileSource(source.ASAAS_ENVIRONMENT ?? "sandbox") }, {
    ...dependencies, createGalaticAsaasClient: () => Object.freeze({ ...dependencies.asaasClient, getWallets: async () => structuredClone(walletResponse) }),
  });
}
export function createGalaticPaymentMaintenance(options) {
  return maintenance({ ...options, store: profileStore(options.store), paymentProfiles: options.paymentProfiles ?? syntheticProfiles(options.store, options.asaasClient) });
}
export function createGalaticPaymentRecovery(options) {
  return recovery({ ...options, store: profileStore(options.store), paymentProfiles: options.paymentProfiles ?? syntheticProfiles(options.store, options.asaasClient) });
}
export function createGalaticFulfillmentService(options) {
  return fulfillment({ ...options, store: profileStore(options.store), paymentProfiles: options.paymentProfiles
    ?? syntheticProfiles(options.store, options.asaasClient, options.environment.asaasEnvironment ?? "sandbox") });
}
