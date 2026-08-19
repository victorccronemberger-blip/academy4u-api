import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

function customerStore() {
  const state = { customer: null, sessions: new Map(), tokens: new Map(), newsletter: null };
  return {
    state, ensureSchema: async () => {}, close: async () => {},
    createCustomer: async (input) => {
      state.customer = { id: crypto.randomUUID(), first_name: input.firstName, last_name: input.lastName,
        name: `${input.firstName} ${input.lastName}`, email: input.email, phone: input.phone,
        email_verified: false, marketing_consent: input.marketingConsent, password_hash: input.passwordHash };
      const { password_hash: _, ...view } = state.customer; return view;
    },
    getCustomerByEmail: async (_email, options = {}) => options.includePassword ? { ...state.customer } : (() => { const { password_hash: _, ...view } = state.customer; return view; })(),
    getCustomerById: async (_id, options = {}) => options.includePassword ? { ...state.customer } : (() => { const { password_hash: _, ...view } = state.customer; return view; })(),
    createCustomerSession: async ({ customerId, tokenHash }) => state.sessions.set(tokenHash, customerId),
    customerForSession: async (hash) => state.sessions.has(hash) ? { customer: (() => { const { password_hash: _, ...view } = state.customer; return view; })(), sessionId: "session-1" } : null,
    revokeCustomerSession: async (hash) => state.sessions.delete(hash),
    revokeOtherCustomerSessions: async () => {},
    createCustomerToken: async ({ customerId, purpose, tokenHash }) => state.tokens.set(`${purpose}:${tokenHash}`, customerId),
    consumeCustomerToken: async (hash, purpose) => state.tokens.get(`${purpose}:${hash}`) ?? null,
    updateCustomerProfile: async (_id, input) => ({ ...state.customer, name: `${input.firstName} ${input.lastName}`, phone: input.phone }),
    updateCustomerPassword: async (_id, passwordHash) => { state.customer.password_hash = passwordHash; },
    listCustomerOrders: async () => [], listCustomerAddresses: async () => [],
    getCustomerPreferences: async () => ({ newsletter_enabled: false, newsletter_status: "disabled" }),
    setCustomerPreferences: async (_id, enabled) => ({ newsletter_enabled: enabled, newsletter_status: enabled ? "active" : "disabled" }),
    upsertNewsletter: async () => {},
    requestNewsletterSubscription: async (value) => { state.newsletter = { ...value, status: "pending" }; },
    confirmNewsletterSubscription: async (hash, unsubscribeHash) => {
      if (state.newsletter?.tokenHash !== hash || state.newsletter.status !== "pending") return null;
      state.newsletter = { ...state.newsletter, tokenHash: unsubscribeHash, status: "active" }; return state.newsletter.email;
    },
    unsubscribeNewsletter: async (hash) => {
      if (state.newsletter?.tokenHash !== hash || state.newsletter.status !== "active") return null;
      state.newsletter.status = "unsubscribed"; return state.newsletter.email;
    },
  };
}

async function start(context, store, dependencies = {}) {
  const { app } = createApp({ PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" }, { stores: { galatic: store }, ...dependencies });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve)); return server.address().port;
}

test("registers, authenticates and protects a Galatic customer with an opaque Bearer session", async (context) => {
  const store = customerStore(); const port = await start(context, store);
  const registration = await fetch(`http://127.0.0.1:${port}/v1/galatic/auth/register`, { method: "POST",
    headers: { "content-type": "application/json", origin: "https://galatic.com.br" },
    body: JSON.stringify({ first_name: "Victor", last_name: "Cronemberger", email: "Victor@Example.com",
      phone: "15997671749", password: "SenhaSegura123", marketing_consent: true }),
  });
  assert.equal(registration.status, 201); const created = await registration.json();
  assert.equal(created.customer.email, "victor@example.com"); assert.match(created.access_token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(registration.headers.get("set-cookie"), null);
  const me = await fetch(`http://127.0.0.1:${port}/v1/galatic/auth/me`, { headers: { authorization: `Bearer ${created.access_token}`, origin: "https://galatic.com.br" } });
  assert.equal(me.status, 200); assert.equal((await me.json()).customer.name, "Victor Cronemberger");
  const anonymous = await fetch(`http://127.0.0.1:${port}/v1/galatic/account/orders`);
  assert.equal(anonymous.status, 401);
});

test("allows PATCH and DELETE in the Galatic CORS contract without accepting another site", async (context) => {
  const port = await start(context, customerStore());
  const allowed = await fetch(`http://127.0.0.1:${port}/v1/galatic/account/profile`, { method: "OPTIONS",
    headers: { origin: "https://galatic.com.br", "access-control-request-method": "PATCH", "access-control-request-headers": "authorization,content-type" } });
  assert.equal(allowed.status, 204); assert.match(allowed.headers.get("access-control-allow-methods"), /PATCH/);
  const blocked = await fetch(`http://127.0.0.1:${port}/v1/galatic/auth/me`, { headers: { origin: "https://evil.example" } });
  assert.equal(blocked.status, 403);
});

test("completes newsletter double opt-in and one-click cancellation", async (context) => {
  const store = customerStore(); const messages = [];
  const notifications = {
    ready: true,
    sendNewsletterVerification: async (value) => messages.push({ type: "verify", ...value }),
    sendNewsletterConfirmed: async (value) => messages.push({ type: "confirmed", ...value }),
    sendNewsletterUnsubscribed: async (value) => messages.push({ type: "unsubscribed", ...value }),
  };
  const port = await start(context, store, { galaticNotifications: notifications });
  const headers = { "content-type": "application/json", origin: "https://galatic.com.br" };
  const subscription = await fetch(`http://127.0.0.1:${port}/v1/galatic/newsletter/subscribe`, { method: "POST", headers,
    body: JSON.stringify({ email: "Victor@Example.com", consent: true }) });
  assert.equal(subscription.status, 200); assert.equal(messages[0].type, "verify");
  assert.match(messages[0].token, /^[a-f0-9]{64}$/);
  const confirmation = await fetch(`http://127.0.0.1:${port}/v1/galatic/newsletter/confirm`, { method: "POST", headers,
    body: JSON.stringify({ token: messages[0].token }) });
  assert.equal(confirmation.status, 200); assert.equal(messages[1].type, "confirmed");
  assert.match(messages[1].unsubscribeToken, /^[a-f0-9]{64}$/);
  const cancellation = await fetch(`http://127.0.0.1:${port}/v1/galatic/newsletter/unsubscribe`, { method: "POST", headers,
    body: JSON.stringify({ token: messages[1].unsubscribeToken }) });
  assert.equal(cancellation.status, 200); assert.equal(messages[2].type, "unsubscribed");
  assert.equal(store.state.newsletter.status, "unsubscribed");
});
