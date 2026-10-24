import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { hashPassword } from "../src/domain/password.js";
import { refundOperationView } from "../src/domain/galatic-refund-operation.js";

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

async function refundHttp(context, { group = false, initial = null, providerResponse, providerError = null, completeDuringRequest = false } = {}) {
  let operation = initial; let mutations = 0; let queued = 0; const alerts = [];
  const orderId = "synthetic-refund-order";
  const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
    adminPaymentContext: async () => ({ id: orderId, status: "paid" }),
    adminOrder: async () => ({ order: { order_number: orderId }, refund_operation: refundOperationView(operation) }),
    adminRefundOperation: async () => refundOperationView(operation),
    claimRefund: async () => {
      if (operation && operation.state !== "rejected") return { claimed: false, state: operation.state };
      operation = { state: "in_progress", attempt_version: (operation?.attempt_version ?? 0) + 1, error_code: null };
      return { claimed: true, group, providerReference: group ? "ins_owned" : "pay_owned", version: operation.attempt_version };
    },
    finishRefundRequest: async (_id, state, error_code, version) => {
      const updated = operation.state !== "completed" && operation.attempt_version === version;
      if (updated) { operation = { state, error_code, attempt_version: version }; if (state === "requested") queued += 1; }
      return { updated, operation: refundOperationView(operation) };
    },
    recordOperationalAlert: async (alert) => { alerts.push(alert); },
  });
  const mutate = async () => {
    mutations += 1;
    if (completeDuringRequest) operation = { ...operation, state: "completed", error_code: null };
    if (providerError) throw providerError;
    return providerResponse;
  };
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" },
    { stores: { galatic: store }, asaasClient: { refundPayment: group ? async () => assert.fail("wrong scope") : mutate,
      refundInstallment: group ? mutate : async () => assert.fail("wrong scope") } });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { base, cookie } = await login(server);
  return {
    post: () => fetch(`${base}/orders/${orderId}/payment/refund`, { method: "POST",
      headers: authenticatedHeaders(cookie, undefined, { "content-type": "application/json" }), body: JSON.stringify({ confirmation: orderId }) }),
    reload: async () => (await fetch(`${base}/orders/${orderId}`, { headers: authenticatedHeaders(cookie) })).json(),
    snapshot: () => ({ operation, mutations, queued, alerts }),
  };
}

for (const group of [false, true]) test(`owned ${group ? "installment" : "payment"} authorization response persists for reload and never repeats the mutation`, async (context) => {
  const journey = await refundHttp(context, { group, providerResponse: { id: group ? "ins_owned" : "pay_owned",
    refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }] } });
  const first = await journey.post(); assert.equal(first.status, 202);
  const body = await first.json();
  assert.deepEqual(body.refund_operation, { state: "requested", attempt_version: 1, error_code: "refund_authorization_required",
    authorization_required: true, authorization_source: "refund_request_response" });
  assert.equal(body.completed, false); assert.equal(body.requested, true);
  assert.deepEqual((await journey.reload()).refund_operation, body.refund_operation);
  assert.deepEqual((await (await journey.post()).json()).refund_operation, body.refund_operation);
  assert.equal(journey.snapshot().mutations, 1); assert.equal(journey.snapshot().queued, 1);
  assert.equal(journey.snapshot().alerts[0].type, "refund_authorization_required");
});

test("foreign, missing, malformed and unknown refund payloads cannot assert operator authorization", async (context) => {
  for (const providerResponse of [undefined, { id: "pay_foreign", refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }] },
    { id: "pay_owned", refunds: [null] }, { id: "pay_owned", refunds: ["AWAITING_CRITICAL_ACTION_AUTHORIZATION"] },
    { id: "pay_owned", refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }, { status: "FUTURE_STATE" }] },
    { id: "pay_owned", refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }, { status: "PENDING" }] },
    { refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }] },
    { id: "pay_owned", refunds: [{ status: "DONE" }] }, { id: "pay_owned", refunds: [] }]) {
    await context.test(JSON.stringify(providerResponse) ?? "missing", async (child) => {
      const journey = await refundHttp(child, { providerResponse });
      const body = await (await journey.post()).json();
      assert.equal(body.state, "requested"); assert.equal(body.refund_operation.authorization_required, false);
      assert.equal(body.refund_operation.error_code, null); assert.equal(body.completed, false);
    });
  }
});

test("a single old partial critical entry is only an indication in the related payment response", async (context) => {
  const journey = await refundHttp(context, { providerResponse: { id: "pay_owned", status: "RECEIVED", value: 150,
    refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION", value: 10, dateCreated: "2020-01-01" }] } });
  const body = await (await journey.post()).json();
  assert.equal(body.state, "requested"); assert.equal(body.completed, false);
  assert.equal(body.refund_operation.authorization_required, true);
  assert.equal(body.refund_operation.authorization_source, "refund_request_response");
  assert.equal(body.message, "Na resposta à solicitação, o Asaas indicou um estorno pendente de autorização no pagamento ou parcelamento relacionado. Verifique os detalhes no painel Asaas.");
  assert.equal(journey.snapshot().alerts[0].summary, body.message);
});

for (const state of ["requested", "in_progress", "uncertain", "completed"]) test(`existing ${state} operation is canonical and never resubmitted`, async (context) => {
  const journey = await refundHttp(context, { initial: { state, attempt_version: 3, error_code: null } });
  const body = await (await journey.post()).json();
  assert.equal(body.state, state); assert.equal(body.completed, state === "completed");
  assert.equal(body.reconciliation_pending, ["in_progress", "uncertain"].includes(state));
  assert.equal(journey.snapshot().mutations, 0); assert.equal(journey.snapshot().alerts.length, 0);
});

test("only an explicitly rejected operation may claim a new version", async (context) => {
  const journey = await refundHttp(context, { initial: { state: "rejected", attempt_version: 3, error_code: "synthetic_rejection" } });
  assert.equal((await (await journey.post()).json()).refund_operation.attempt_version, 4);
  assert.equal(journey.snapshot().mutations, 1);
});

for (const providerError of [null, Object.assign(new Error("synthetic_timeout"), { code: "asaas_timeout" }),
  Object.assign(new Error("synthetic_rejected"), { status: 422 })]) test(`completion during SDK POST wins over ${providerError?.message ?? "authorization response"}`, async (context) => {
  const journey = await refundHttp(context, { completeDuringRequest: true, providerError,
    providerResponse: { id: "pay_owned", refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }] } });
  const result = await journey.post(); assert.equal(result.status, 202);
  const body = await result.json(); assert.equal(body.state, "completed"); assert.equal(body.completed, true);
  assert.equal(body.requested, false); assert.equal(body.refund_operation.authorization_required, false);
  assert.equal(journey.snapshot().queued, 0); assert.equal(journey.snapshot().alerts.length, 0);
});

test("production label route verifies the injected production payment and reports an unverified order as 409", async (context) => {
  const orderId = "20d42dfd-9bf6-44f3-932b-625b475e324a"; let available = false; let claims = 0; let labels = 0; let stored = null;
  const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
    shipmentForOrder: async () => stored,
    shipmentCreationContext: async () => ({ id: orderId, payment_status: "paid", payment_provider: "asaas",
      payment_provider_order_id: "pay_synthetic_production", payment_provider_group_id: null, payment_method: "pix", installments: 1, total_cents: 12000,
      service_code: "correios:pac", shipping_address: { street: "Rua B", number: "2", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
      items: [{ title: "Synthetic", quantity: 1, unit_amount_cents: 12000, weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 }] }),
    getCheckoutRecovery: async () => null,
    claimShipmentCreation: async () => { claims += 1; return { claimed: true }; },
    saveShipment: async (_orderId, value) => (stored = { order_id: orderId, tracking_code: value.trackingCode }),
    completeShipmentCreation: async () => {},
  });
  const { app } = createApp({ ASAAS_ENABLED: "false", ASAAS_ENVIRONMENT: "production", PAYMENT_TENANTS: "galatic",
    GALATIC_ENVIA_ENVIRONMENT: "production", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
    GALATIC_SHIPPING_NAME: "Synthetic", GALATIC_SHIPPING_EMAIL: "synthetic@example.test", GALATIC_SHIPPING_PHONE: "11999999999",
    GALATIC_SHIPPING_STREET: "Rua A", GALATIC_SHIPPING_NUMBER: "1", GALATIC_SHIPPING_DISTRICT: "Centro", GALATIC_SHIPPING_CITY: "Sao Paulo",
    GALATIC_SHIPPING_STATE: "SP", GALATIC_SHIPPING_POSTAL_CODE: "01001000", GALATIC_SHIPPING_TAX_ID: "11222333000181" },
  { stores: { galatic: store }, asaasClient: { getPayment: async () => {
    if (!available) throw Object.assign(new Error("synthetic_not_found"), { status: 404 });
    return { id: "pay_synthetic_production", externalReference: `galatic:${orderId}`, customer: "cus_synthetic", billingType: "PIX", value: 120, status: "CONFIRMED" };
  } }, enviaClient: { ready: true, generateLabel: async () => { labels += 1; return { data: [{ trackingNumber: "BR-SYNTHETIC" }] }; } } });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { base, cookie } = await login(server);
  const post = () => fetch(`${base}/orders/${orderId}/shipping/label`, { method: "POST",
    headers: authenticatedHeaders(cookie, "https://galatic.com.br", { "content-type": "application/json" }), body: "{}" });
  const blocked = await post(); assert.equal(blocked.status, 409);
  const body = await blocked.json(); assert.equal(body.error, "shipping_payment_unverified");
  assert.match(body.message, /conta Asaas de produção/); assert.equal(claims, 0); assert.equal(labels, 0);
  available = true;
  assert.equal((await post()).status, 201); assert.equal(claims, 1); assert.equal(labels, 1);
  available = false;
  assert.equal((await post()).status, 200); assert.equal(claims, 1); assert.equal(labels, 1);
});

for (const installments of [2, 10]) test(`refunds the full ${installments}x group once and never resends an uncertain refund`, async (context) => {
  const calls = []; let state = null;
  const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
    adminPaymentContext: async () => ({ id: "order-refund-group", providerOrderId: "pay_first", providerGroupId: "ins_full_group", status: "paid" }),
    claimRefund: async () => state ? { claimed: false, state } : ((state = "in_progress"), { claimed: true, group: true, providerReference: "ins_full_group", version: 1 }),
    finishRefundRequest: async (_orderId, next) => { state = next; return { updated: true }; },
    adminRefundOperation: async () => ({ state, attempt_version: 1, error_code: null, authorization_required: false, authorization_source: null }),
  });
  const asaasClient = { refundPayment: async () => assert.fail("a group must not refund only its first payment"),
    refundInstallment: async (...args) => { calls.push(args); throw Object.assign(new Error("synthetic_timeout"), { code: "asaas_timeout" }); } };
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" }, { stores: { galatic: store }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { base, cookie } = await login(server);
  const post = () => fetch(`${base}/orders/order-refund-group/payment/refund`, { method: "POST",
    headers: authenticatedHeaders(cookie, "https://galatic.com.br", { "content-type": "application/json" }), body: JSON.stringify({ confirmation: "order-refund-group" }) });
  const first = await post(); assert.equal(first.status, 202);
  assert.equal((await first.json()).error, "refund_reconciliation_pending");
  assert.equal((await post()).status, 202);
  assert.deepEqual(calls, [["ins_full_group"]]); assert.equal(state, "uncertain");
});

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

test("paginates administrative product and content queries on the server", async (context) => {
  const calls = [];
  const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
    adminSearchProducts: async (options) => {
      calls.push(["products", options]);
      return { products: [{ sku: "PAGE-01", name: "Produto paginado" }],
        pagination: { page: 3, per_page: 25, total: 76, pages: 4 }, facets: { categories: [], b2b: 0 } };
    },
    adminContentFiscalPage: async (options) => {
      calls.push(["content", options]);
      return { products: [{ sku: "PAGE-02", name: "Conteúdo paginado" }], summary: { total: 76 },
        pagination: { page: 2, per_page: 50, total: 76, pages: 2 } };
    },
  });
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br", GALATIC_DATABASE_URL: "mysql://galatic:test@127.0.0.1/galatic" },
  { stores: { galatic: store } });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { base, cookie } = await login(server);

  const products = await fetch(`${base}/products?page=3&per_page=25&q=cartas&category=Fam%C3%ADlia&status=active`, {
    headers: authenticatedHeaders(cookie),
  });
  assert.equal(products.status, 200);
  assert.equal((await products.json()).pagination.total, 76);
  const content = await fetch(`${base}/content-fiscal?page=2&per_page=50&q=seo&editorial=review&issue=merchant`, {
    headers: authenticatedHeaders(cookie),
  });
  assert.equal(content.status, 200);
  assert.equal((await content.json()).products[0].sku, "PAGE-02");
  assert.deepEqual(calls, [
    ["products", { page: 3, perPage: 25, query: "cartas", category: "Família", status: "active" }],
    ["content", { page: 2, perPage: 50, query: "seo", editorial: "review", issue: "merchant" }],
  ]);
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

test("reports technical configuration separately from sales and commercial catalog evidence", async (context) => {
  const baseEnvironment = {
    ASAAS_ENABLED: "true", PAYMENT_TENANTS: "galatic",
    GALATIC_SALES_ENABLED: "false",
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
  const product = { active: 1, weight_grams: 500, length_cm: 20, width_cm: 15, height_cm: 6, manage_stock: 0 };
  const products = [{ ...product, cost_amount: null }];
  async function readinessFor(asaasEnvironment, shippingEnvironment = "production") {
    const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
      adminListProducts: async () => products,
    });
    const { app } = createApp({
      ...baseEnvironment,
      ASAAS_ENVIRONMENT: asaasEnvironment,
      GALATIC_ENVIA_ENVIRONMENT: shippingEnvironment,
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
  assert.equal(sandbox.configuration_ready, false);
  assert.equal(sandbox.payment_environment, "sandbox");
  assert.equal(sandbox.checks.find((item) => item.key === "payment_environment").passed, false);

  const production = await readinessFor("production");
  assert.equal(production.sandbox_ready, true);
  assert.equal(production.production_ready, true);
  assert.equal(production.configuration_ready, true);
  assert.equal(production.scope, "technical_configuration");
  assert.equal(production.sales_enabled, false);
  assert.equal(production.checkout_enabled, true);
  assert.equal(production.catalog.stock_not_managed, 1);
  assert.equal(production.catalog.missing_cost, 1);
  assert.equal(production.payment_environment, "production");
  assert.equal(production.shipping_environment, "production");

  const shippingSandbox = await readinessFor("production", "sandbox");
  assert.equal(shippingSandbox.configuration_ready, false);
  assert.equal(shippingSandbox.production_ready, false);
  assert.equal(shippingSandbox.sandbox_ready, true);
  assert.equal(shippingSandbox.shipping_environment, "sandbox");
  assert.equal(shippingSandbox.checks.find((item) => item.key === "shipping_environment").passed, false);

  products.splice(0, products.length, ...[undefined, null, "", "  ", -1, 1.5, "invalid", false, {}, 0, "0", 1200, "1200"]
    .map((cost_amount) => ({ ...product, cost_amount })), { ...product, active: 0, cost_amount: null });
  const mixedCosts = await readinessFor("production", "sandbox");
  assert.equal(mixedCosts.catalog.active_products, 13);
  assert.equal(mixedCosts.catalog.missing_cost, 9);
  assert.equal(mixedCosts.sandbox_ready, true);
});

test("preserves unknown product costs and validates explicit costs before store mutation", async (context) => {
  const current = { sku: "TEST-COST", slug: "test-cost", name: "Synthetic product", unit_amount: 12000,
    cost_amount: null, active: 1, manage_stock: 1, stock_quantity: 10 };
  const writes = [];
  const store = adminStore(await hashPassword("StrongAdminPassword!42"), {
    adminListProducts: async () => [{ ...current }],
    adminUpsertProduct: async (product) => { writes.push(product); return true; },
  });
  const { app } = createApp({ ASAAS_ENABLED: "false", PAYMENT_TENANTS: "galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" }, { stores: { galatic: store }, asaasClient: {}, enviaClient: {} });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { base, cookie } = await login(server);
  const headers = authenticatedHeaders(cookie, "https://galatic.com.br", { "content-type": "application/json" });
  async function update(body, method = "PATCH") {
    return fetch(`${base}/products${method === "PATCH" ? "/TEST-COST" : ""}`, {
      method, headers, body: JSON.stringify(method === "POST" ? { ...current, ...body } : body),
    });
  }

  const unrelated = await update({ name: "Renamed synthetic product" });
  assert.equal(unrelated.status, 200);
  assert.equal((await unrelated.json()).product.costAmount, null);
  assert.equal(writes.at(-1).costAmount, null);

  current.cost_amount = undefined;
  const missingCost = await update({ description: "Synthetic description" });
  assert.equal(missingCost.status, 200);
  assert.equal((await missingCost.json()).product.costAmount, null);
  current.cost_amount = 900;

  for (const [body, expected] of [
    [{ cost_amount: null }, null], [{ cost_amount: "" }, null], [{ cost_amount: "  " }, null],
    [{ cost_amount: 0 }, 0], [{ cost_amount: "0" }, 0], [{ cost_amount: 1250 }, 1250],
    [{ cost: "12.50" }, 1250], [{ cost: 0 }, 0], [{ cost: null }, null], [{ cost: "" }, null],
  ]) {
    await context.test(`accepts ${JSON.stringify(body)} as ${expected}`, async () => {
      const result = await update(body);
      assert.equal(result.status, 200);
      assert.equal((await result.json()).product.costAmount, expected);
      assert.equal(writes.at(-1).costAmount, expected);
    });
  }

  const createdUnknown = await update({ cost_amount: null }, "POST");
  assert.equal(createdUnknown.status, 201);
  assert.equal((await createdUnknown.json()).product.costAmount, null);
  for (const body of [
    { cost_amount: -1 }, { cost_amount: 1.5 }, { cost_amount: "invalid" }, { cost_amount: "NaN" },
    { cost_amount: false }, { cost_amount: [] }, { cost_amount: Number.MAX_SAFE_INTEGER + 1 },
    { cost_amount: undefined, cost: -0.001 }, { cost_amount: undefined, cost: "invalid" },
    { cost_amount: undefined, cost: "Infinity" }, { cost_amount: undefined, cost: {} },
  ]) {
    await context.test(`rejects ${JSON.stringify(body)} without mutation`, async () => {
      const before = writes.length;
      const result = await update(body);
      assert.equal(result.status, 400);
      assert.equal((await result.json()).error, "invalid_product");
      assert.equal(writes.length, before);
    });
  }
  const beforeCreate = writes.length;
  const invalidCreate = await update({ cost_amount: -1 }, "POST");
  assert.equal(invalidCreate.status, 400);
  assert.equal((await invalidCreate.json()).error, "invalid_product");
  assert.equal(writes.length, beforeCreate);
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
    claimRefund: async () => ({ claimed: true, providerReference: "pay_paid_123", group: false, version: 1 }),
    finishRefundRequest: async () => ({ updated: true }),
    adminRefundOperation: async () => ({ state: "requested", attempt_version: 1, error_code: null, authorization_required: false, authorization_source: null }),
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
