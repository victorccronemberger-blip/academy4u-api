import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { hashPassword } from "../src/domain/password.js";

function adminStore(passwordHash) {
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
  };
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
