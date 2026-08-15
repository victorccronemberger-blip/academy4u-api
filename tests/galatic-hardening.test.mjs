import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { getEnvironment } from "../src/config/environment.js";
import { createGalaticMySqlStore } from "../src/store/galatic-mysql-store.js";

function fakeGalaticStore() {
  return {
    ensureSchema: async () => {}, close: async () => {},
    prepareOrder: async () => ({ kind: "created", order: { id: "52c02ff3-b755-4df5-90ba-20ea8c8bd035", subtotalCents: 44999, shippingCents: 2500, totalCents: 47499, lines: [] } }),
    attachPayment: async () => {},
    completeCheckoutAttempt: async () => {},
    releaseFailedOrder: async () => assert.fail("order should not be released"),
    getOrderByPublicId: async () => null,
    updateOrderFromWebhook: async () => ({ deferred: true }),
  };
}

function startApp(context, overrides, dependencies) {
  const { app } = createApp({
    ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
    ...overrides,
  }, dependencies);
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  return new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
}

const validOrder = {
  items: [{ sku: "DEP001", quantity: 1 }],
  buyer: {
    firstName: "Victor", lastName: "Cronemberger",
    email: "victor@example.com", phone: "15997671749", documentNumber: "19100000000",
    address: { postal_code: "06020190", street: "Avenida Franz Voegeli", number: "501", district: "Parque Continental", city: "Osasco", state: "SP" },
  },
  shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" },
  payment: { method: "pix" },
};

test("rejects a Galatic order whose CPF fails the check digits", async (context) => {
  const port = await startApp(context, {}, { stores: { galatic: fakeGalaticStore() }, asaasClient: {} });
  const response = await fetch(`http://127.0.0.1:${port}/v1/galatic/checkout/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ...validOrder, buyer: { ...validOrder.buyer, documentNumber: "19100000001" } }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "invalid_checkout");
  assert.equal(body.message, "CPF ou CNPJ inválido.");
});

test("acknowledges an unexpected installment webhook instead of failing with 500", async (context) => {
  const calls = [];
  const store = {
    ...fakeGalaticStore(),
    updatePaymentInstallmentFromWebhook: async (payload) => { calls.push(payload); return { duplicate: false }; },
  };
  const port = await startApp(context, { ASAAS_SANDBOX_WEBHOOK_TOKEN: "whsec_test" }, { stores: { galatic: store }, asaasClient: {} });
  const response = await fetch(`http://127.0.0.1:${port}/v1/webhooks/asaas`, {
    method: "POST",
    headers: { "content-type": "application/json", "asaas-access-token": "whsec_test" },
    body: JSON.stringify({
      event: "PAYMENT_RECEIVED", id: "evt_installment_1",
      payment: {
        id: "pay_galatic_1", installment: "grp_galatic_1", installmentNumber: 1,
        dueDate: "2026-08-20", value: 474.99, status: "RECEIVED",
        externalReference: "galatic:52c02ff3-b755-4df5-90ba-20ea8c8bd035",
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.received, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerOrderId, "pay_galatic_1");
  assert.equal(calls[0].installment.number, 1);
});

test("fails closed with 503 when the Galatic shipping origin is not configured", async (context) => {
  const port = await startApp(context, { GALATIC_ENVIA_API_KEY: "envia_test" }, { stores: { galatic: fakeGalaticStore() }, asaasClient: {} });
  const response = await fetch(`http://127.0.0.1:${port}/v1/galatic/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ sku: "DEP001", quantity: 1 }], postalCode: "06020190" }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "shipping_unavailable");
});

test("parses the Galatic shipping origin only when the full variable set is present", () => {
  const complete = {
    GALATIC_SHIPPING_NAME: "Galatic Games", GALATIC_SHIPPING_EMAIL: "comercial@example.com",
    GALATIC_SHIPPING_PHONE: "(15) 99767-1749", GALATIC_SHIPPING_STREET: "Avenida Exemplo",
    GALATIC_SHIPPING_NUMBER: "501", GALATIC_SHIPPING_DISTRICT: "Centro",
    GALATIC_SHIPPING_CITY: "Osasco", GALATIC_SHIPPING_STATE: "sp",
    GALATIC_SHIPPING_POSTAL_CODE: "06020-190", GALATIC_SHIPPING_TAX_ID: "67.956.916/0001-90",
  };
  const origin = getEnvironment(complete).galaticShippingOrigin;
  assert.equal(origin.name, "Galatic Games");
  assert.equal(origin.phone, "15997671749");
  assert.equal(origin.state, "SP");
  assert.equal(origin.postalCode, "06020190");
  assert.equal(origin.taxId, "67956916000190");
  const { GALATIC_SHIPPING_TAX_ID: _omitted, ...partial } = complete;
  assert.equal(getEnvironment(partial).galaticShippingOrigin, null);
});

test("passes the configured Galatic shipping origin into the tenant router", async (context) => {
  const complete = {
    GALATIC_ENVIA_API_KEY: "envia_test", GALATIC_SHIPPING_NAME: "Galatic Games",
    GALATIC_SHIPPING_EMAIL: "comercial@example.com", GALATIC_SHIPPING_PHONE: "15997671749",
    GALATIC_SHIPPING_STREET: "Avenida Exemplo", GALATIC_SHIPPING_NUMBER: "501",
    GALATIC_SHIPPING_DISTRICT: "Centro", GALATIC_SHIPPING_CITY: "Osasco", GALATIC_SHIPPING_STATE: "SP",
    GALATIC_SHIPPING_POSTAL_CODE: "06020190", GALATIC_SHIPPING_TAX_ID: "67956916000190",
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    if (String(url).includes("viacep")) return new Response(JSON.stringify({ logradouro: "Avenida Teste", bairro: "Centro", localidade: "Osasco", uf: "SP" }), { status: 200 });
    return new Response(JSON.stringify({ data: [{ carrierDescription: "Correios", serviceDescription: "PAC", service: "PAC", totalPrice: 25, deliveryDate: { dateDifference: 4 } }] }), { status: 200 });
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const galaticStore = { ...fakeGalaticStore(),
    getProductsForCheckout: async () => [{ sku: "DEP001", slug: "deep-regrets", title: "Deep Regrets", unitAmountCents: 44999,
      active: true, manageStock: true, stockQuantity: 2, weightGrams: 1200, lengthCm: 30, widthCm: 30, heightCm: 8 }],
    createShippingQuotes: async ({ quotes }) => quotes.map((quote) => ({ ...quote, id: crypto.randomUUID() })),
  };
  const port = await startApp(context, complete, { stores: { galatic: galaticStore }, asaasClient: {} });
  const response = await originalFetch(`http://127.0.0.1:${port}/v1/galatic/quote`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ sku: "DEP001", quantity: 1 }], postalCode: "06020190" }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).quotes[0].amount, 2500);
  assert.equal(calls.some((call) => call.url.includes("api-test.envia.com")), true);
});

test("the real Galatic MySQL store implements the full webhook store interface", async () => {
  const store = createGalaticMySqlStore("mysql://galatic:secret@127.0.0.1:3306/galatic");
  try {
    assert.equal(typeof store.updatePaymentInstallmentFromWebhook, "function");
    assert.equal(typeof store.recordOperationalAlert, "function");
    assert.equal(typeof store.updateOrderFromWebhook, "function");
  } finally {
    await store.close();
  }
});
