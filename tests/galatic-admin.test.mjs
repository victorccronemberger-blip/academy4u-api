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
  return { base, credentials: await response.json() };
}

test("protects the existing Galatic admin panel with an opaque API session", async (context) => {
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
  assert.match(credentials.access_token, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(credentials.admin.role, "owner");

  const dashboard = await fetch(`${base}/dashboard`, { headers: { origin: "https://galatic.com.br", authorization: `Bearer ${credentials.access_token}` } });
  assert.equal(dashboard.status, 200);
  assert.deepEqual((await dashboard.json()).metrics, { orders_today: 2, revenue_today: 89998, pending_shipments: 1 });

  const foreignOrigin = await fetch(`${base}/dashboard`, { headers: { origin: "https://academy4u.com.br", authorization: `Bearer ${credentials.access_token}` } });
  assert.equal(foreignOrigin.status, 403);
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
  const { base, credentials } = await login(server);
  const result = await fetch(`${base}/orders/order-123/payment/cancel`, { method: "POST",
    headers: { origin: "https://galatic.com.br", authorization: `Bearer ${credentials.access_token}` } });
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
  const { base, credentials } = await login(server);
  const headers = { origin: "https://galatic.com.br", authorization: `Bearer ${credentials.access_token}`, "content-type": "application/json" };
  const denied = await fetch(`${base}/orders/order-paid-123/payment/refund`, { method: "POST", headers,
    body: JSON.stringify({ confirmation: "errado" }) });
  assert.equal(denied.status, 400);
  assert.equal(refunds, 0);
  const accepted = await fetch(`${base}/orders/order-paid-123/payment/refund`, { method: "POST", headers,
    body: JSON.stringify({ confirmation: "order-paid-123" }) });
  assert.equal(accepted.status, 202);
  assert.equal(refunds, 1);
});
