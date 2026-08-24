import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { hashPassword } from "../src/domain/password.js";

function adminStore(passwordHash, additions = {}) {
  const sessions = new Set();
  const admin = { id: "0bff1c52-36e5-45de-9705-0db72ffd163a", name: "Admin Galatic",
    email: "admin@galatic.com.br", role: "owner", status: "active", password_hash: passwordHash };
  return {
    ensureSchema: async () => {}, close: async () => {},
    getAdminByEmail: async (email) => email === admin.email ? { ...admin } : null,
    createInitialAdmin: async () => ({ ...admin }),
    createAdminSession: async ({ tokenHash }) => { sessions.add(tokenHash); },
    adminForSession: async (tokenHash) => sessions.has(tokenHash) ? { ...admin } : null,
    revokeAdminSession: async (tokenHash) => { sessions.delete(tokenHash); },
    adminDashboard: async () => ({ orders_today: 2, revenue_today: 89998, pending_shipments: 1 }),
    ...additions,
  };
}

async function login(server, password = "StrongAdminPassword!42") {
  const base = `http://127.0.0.1:${server.address().port}/v1/galatic/admin`;
  const response = await fetch(`${base}/login`, { method: "POST",
    headers: { origin: "https://galatic.com.br", "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@galatic.com.br", password }) });
  return { base, credentials: await response.json(), cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

const authenticatedHeaders = (cookie, origin = "https://galatic.com.br", additions = {}) => ({ origin, cookie, ...additions });

test("protects the existing Galatic admin panel with an HttpOnly cookie session", async (context) => {
  const store = adminStore(await hashPassword("StrongAdminPassword!42"));
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br", GALATIC_DATABASE_URL: "mysql://galatic:test@127.0.0.1/galatic" },
  { stores: { galatic: store } });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/galatic/admin`;

  const denied = await fetch(`${base}/dashboard`, { headers: { origin: "https://galatic.com.br" } });
  assert.equal(denied.status, 401);
  const login = await fetch(`${base}/login`, { method: "POST", headers: { origin: "https://galatic.com.br", "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@galatic.com.br", password: "StrongAdminPassword!42" }) });
  assert.equal(login.status, 200);
  const credentials = await login.json();
  assert.equal(credentials.access_token, undefined);
  assert.equal(credentials.admin.role, "owner");
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.match(cookie, /^__Host-galatic_admin_session=/);

  const dashboard = await fetch(`${base}/dashboard`, { headers: authenticatedHeaders(cookie) });
  assert.equal(dashboard.status, 200);
  assert.deepEqual((await dashboard.json()).metrics, { orders_today: 2, revenue_today: 89998, pending_shipments: 1 });

  const foreignOrigin = await fetch(`${base}/dashboard`, { headers: authenticatedHeaders(cookie, "https://academy4u.com.br") });
  assert.equal(foreignOrigin.status, 403);
});

test("requires the shared anti-bot proof before an administrative login", async (context) => {
  const store = adminStore(await hashPassword("StrongAdminPassword!42"));
  const botChallenge = {
    issue: (_request, response) => response.status(204).end(),
    verify: (request, response, next) => request.get("x-galatic-bot-proof") === "valid-proof"
      ? next()
      : response.status(400).json({ error: "bot_challenge_required" }),
  };
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" }, { stores: { galatic: store }, botChallenge });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/galatic/admin/login`;
  const body = JSON.stringify({ email: "admin@galatic.com.br", password: "StrongAdminPassword!42" });
  const denied = await fetch(url, { method: "POST", headers: {
    origin: "https://galatic.com.br", "content-type": "application/json" }, body });
  assert.equal(denied.status, 400); assert.equal((await denied.json()).error, "bot_challenge_required");
  const accepted = await fetch(url, { method: "POST", headers: {
    origin: "https://galatic.com.br", "content-type": "application/json", "x-galatic-bot-proof": "valid-proof" }, body });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).access_token, undefined);
});

test("does not declare production readiness while Galatic payments are still in sandbox", async (context) => {
  const baseEnvironment = {
    ASAAS_ENABLED: "true", PAYMENT_TENANTS: "galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
    GALATIC_DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    GALATIC_DATABASE_URL: "mysql://galatic:test@127.0.0.1/galatic",
    GALATIC_ENVIA_API_KEY: "envia_test", GALATIC_ENVIA_ENVIRONMENT: "production",
    GALATIC_ENVIA_WEBHOOK_TOKEN: "envia-webhook-token",
    GALATIC_SHIPPING_NAME: "Galatic Games", GALATIC_SHIPPING_EMAIL: "comercial@galatic.com.br",
    GALATIC_SHIPPING_PHONE: "15997671749", GALATIC_SHIPPING_STREET: "Avenida Franz Voegeli",
    GALATIC_SHIPPING_NUMBER: "501", GALATIC_SHIPPING_DISTRICT: "Parque Continental",
    GALATIC_SHIPPING_CITY: "Osasco", GALATIC_SHIPPING_STATE: "SP",
    GALATIC_SHIPPING_POSTAL_CODE: "06020190", GALATIC_SHIPPING_TAX_ID: "67956916000190",
  };
  const products = [{ active: 1, weight_grams: 500, length_cm: 20, width_cm: 15, height_cm: 6, manage_stock: 0 }];
  async function readinessFor(asaasEnvironment) {
    const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
      adminListProducts: async () => products,
    });
    const { app } = createApp({
      ...baseEnvironment,
      ASAAS_ENVIRONMENT: asaasEnvironment,
      ASAAS_SANDBOX: "$aact_sandbox_key",
      ASAAS_API_KEY: "$aact_production_key",
      ASAAS_SANDBOX_WEBHOOK_TOKEN: "sandbox-webhook-token",
      ASAAS_WEBHOOK_TOKEN: "production-webhook-token",
    }, {
      stores: { galatic: store },
      asaasClient: {}, enviaClient: {},
      galaticNotifications: { ready: true, provider: "hostinger-mail-api" },
    });
    const server = app.listen(0, "127.0.0.1");
    context.after(() => server.close());
    await new Promise((resolve) => server.once("listening", resolve));
    const authenticated = await login(server);
    const response = await fetch(`${authenticated.base}/readiness`, {
      headers: authenticatedHeaders(authenticated.cookie),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const sandbox = await readinessFor("sandbox");
  assert.equal(sandbox.sandbox_ready, true);
  assert.equal(sandbox.production_ready, false);
  assert.equal(sandbox.payment_environment, "sandbox");
  assert.equal(sandbox.checks.find((item) => item.key === "payment_environment").passed, false);

  const production = await readinessFor("production");
  assert.equal(production.sandbox_ready, true);
  assert.equal(production.production_ready, true);
  assert.equal(production.payment_environment, "production");
});

test("cancels an unpaid Asaas charge before releasing the Galatic order", async (context) => {
  const calls = [];
  const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
    adminPaymentContext: async () => ({ id: "order-123", providerOrderId: "pay_pending_123", providerGroupId: null, status: "open" }),
    adminCancelUnpaidOrder: async (id) => { calls.push(["store", id]); return true; },
  });
  const asaasClient = {
    getPayment: async (id) => { calls.push(["get", id]); return { status: "PENDING" }; },
    deletePayment: async (id) => { calls.push(["delete", id]); return { deleted: true }; },
  };
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br", GALATIC_DATABASE_URL: "mysql://galatic:test@127.0.0.1/galatic" },
  { stores: { galatic: store }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { base, cookie } = await login(server);
  const result = await fetch(`${base}/orders/order-123/payment/cancel`, { method: "POST",
    headers: authenticatedHeaders(cookie) });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [["get", "pay_pending_123"], ["delete", "pay_pending_123"], ["store", "order-123"]]);
});

test("requires the full order number before requesting an Asaas refund", async (context) => {
  let refunds = 0;
  const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
    adminPaymentContext: async () => ({ id: "order-paid-123", providerOrderId: "pay_paid_123", status: "paid" }),
    recordOperationalAlert: async () => {},
  });
  const asaasClient = { refundPayment: async () => { refunds += 1; } };
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br", GALATIC_DATABASE_URL: "mysql://galatic:test@127.0.0.1/galatic" },
  { stores: { galatic: store }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { base, cookie } = await login(server);
  const headers = authenticatedHeaders(cookie, "https://galatic.com.br", { "content-type": "application/json" });
  const denied = await fetch(`${base}/orders/order-paid-123/payment/refund`, { method: "POST", headers,
    body: JSON.stringify({ confirmation: "errado" }) });
  assert.equal(denied.status, 400);
  assert.equal(refunds, 0);
  const accepted = await fetch(`${base}/orders/order-paid-123/payment/refund`, { method: "POST", headers,
    body: JSON.stringify({ confirmation: "order-paid-123" }) });
  assert.equal(accepted.status, 202);
  assert.equal(refunds, 1);
});
