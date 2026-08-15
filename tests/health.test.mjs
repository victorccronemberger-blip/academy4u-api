import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";

const TRUSTED_TOKEN = "academy-trusted-checkout-token-2026";

const enabledEnvironment = {
  ASAAS_ENABLED: "true",
  ASAAS_ENVIRONMENT: "sandbox",
  ASAAS_API_KEY: "$aact_test_key",
  ASAAS_WEBHOOK_TOKEN: "academy-webhook-token-with-more-than-32-characters",
  TRUSTED_CHECKOUT_TOKEN: TRUSTED_TOKEN,
};

async function serve(context, overrides = {}, dependencies = {}) {
  const { app } = createApp({
    PORT: "3100",
    PUBLIC_ORIGIN: "https://academy4u.com.br",
    ...overrides,
  }, dependencies);
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function buyer() {
  return {
    firstName: "Victor",
    lastName: "Cronemberger",
    email: "victor@example.com",
    phone: "11999999999",
    documentNumber: "19100000000",
  };
}

function cardBuyer() {
  return {
    ...buyer(),
    address: { postCode: "30140071", number: "100" },
  };
}

function trustedHeaders(key = crypto.randomUUID(), token = TRUSTED_TOKEN) {
  return {
    "content-type": "application/json",
    "idempotency-key": key,
    "x-academy-trusted-token": token,
  };
}

test("reports a healthy API while keeping checkout disabled without Asaas credentials", async (context) => {
  const origin = await serve(context, { ASAAS_ENABLED: "true" });
  const response = await fetch(`${origin}/health`, {
    headers: { origin: "https://academy4u.com.br" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://academy4u.com.br");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "academy-api",
    database: { status: "ready", error: null },
    capabilities: { checkout: false },
  });

  const status = await fetch(`${origin}/v1/checkout/status`);
  assert.deepEqual(await status.json(), {
    enabled: false,
    provider: "asaas",
    environment: "sandbox",
    methods: [],
    cardMode: "embedded_api",
    cardInstallmentMaximum: 10,
    pixInstallmentMode: "monthly_manual_payment",
    pixInstallmentMaximum: 6,
    pixAutomatic: false,
    minimumPixInstallmentCents: 1000,
    minimumCardInstallmentCents: 500,
  });
});

test("restores an Asaas key prefix stripped by a managed runtime", () => {
  const { environment } = createApp({
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_API_KEY: "aact_test_key",
  });
  assert.equal(environment.asaasApiKey, "$aact_test_key");
  assert.equal(environment.checkoutEnabled, true);
});

test("removes a transport escape preserved before an Asaas key", () => {
  const { environment } = createApp({
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_API_KEY: "\\$aact_test_key",
  });
  assert.equal(environment.asaasApiKey, "$aact_test_key");
  assert.equal(environment.checkoutEnabled, true);
});

test("selects the dedicated sandbox key without replacing the production key", () => {
  const sandbox = createApp({
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_SANDBOX: "aact_sandbox_key",
    ASAAS_API_KEY: "aact_production_key",
  }).environment;
  assert.equal(sandbox.asaasApiKey, "$aact_sandbox_key");
  assert.equal(sandbox.asaasApiOrigin, "https://api-sandbox.asaas.com/v3");

  const production = createApp({
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "production",
    ASAAS_SANDBOX: "aact_sandbox_key",
    ASAAS_API_KEY: "aact_production_key",
  }).environment;
  assert.equal(production.asaasApiKey, "$aact_production_key");
  assert.equal(production.asaasApiOrigin, "https://api.asaas.com/v3");
});

test("keeps production and sandbox webhook tokens isolated", () => {
  const shared = {
    ASAAS_ENABLED: "true",
    ASAAS_SANDBOX: "aact_sandbox_key",
    ASAAS_API_KEY: "aact_production_key",
    ASAAS_WEBHOOK_TOKEN: "production-webhook-token-with-32-characters",
    ASAAS_SANDBOX_WEBHOOK_TOKEN: "sandbox-webhook-token-with-32-characters",
  };
  assert.equal(createApp({ ...shared, ASAAS_ENVIRONMENT: "sandbox" }).environment.asaasWebhookToken, shared.ASAAS_SANDBOX_WEBHOOK_TOKEN);
  assert.equal(createApp({ ...shared, ASAAS_ENVIRONMENT: "production" }).environment.asaasWebhookToken, shared.ASAAS_WEBHOOK_TOKEN);
});

test("applies the LMS runtime production mode with a hashed webhook credential", async (context) => {
  const productionWebhookToken = "production-webhook-token-generated-by-provider";
  const store = createInMemoryStore();
  store.getPaymentRuntimeConfig = async () => ({
    environment: "production",
    productionWebhookTokenHash: createHash("sha256").update(productionWebhookToken).digest("hex"),
  });
  const origin = await serve(context, {
    ...enabledEnvironment,
    ASAAS_SANDBOX: "aact_sandbox_key",
    ASAAS_API_KEY: "aact_production_key",
  }, { store, asaasClient: {} });

  const status = await fetch(`${origin}/v1/checkout/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).environment, "production");

  const event = {
    id: "evt_runtime_production_6001",
    event: "PAYMENT_CONFIRMED",
    payment: {
      id: "pay_runtime6001",
      status: "CONFIRMED",
      externalReference: "academy:runtime-production-6001",
    },
  };
  const legacyToken = await fetch(`${origin}/v1/webhooks/asaas`, {
    method: "POST",
    headers: { "content-type": "application/json", "asaas-access-token": enabledEnvironment.ASAAS_WEBHOOK_TOKEN },
    body: JSON.stringify(event),
  });
  assert.equal(legacyToken.status, 401);
  const accepted = await fetch(`${origin}/v1/webhooks/asaas`, {
    method: "POST",
    headers: { "content-type": "application/json", "asaas-access-token": productionWebhookToken },
    body: JSON.stringify(event),
  });
  assert.equal(accepted.status, 200);
});

test("rejects order creation without the trusted frontend token", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const payload = JSON.stringify({
    slugs: ["novo-cpa"],
    couponCode: null,
    buyer: buyer(),
    payment: { method: "pix" },
  });
  const missing = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: payload,
  });
  assert.equal(missing.status, 401);
  const wrong = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(crypto.randomUUID(), "token-errado"),
    body: payload,
  });
  assert.equal(wrong.status, 401);
});

test("creates a Pix charge from server-authoritative prices", async (context) => {
  const calls = [];
  const asaasClient = {
    findCustomersByDocument: async (document) => {
      calls.push(["findCustomer", document]);
      return { data: [] };
    },
    createCustomer: async (payload) => {
      calls.push(["customer", payload]);
      return { id: "cus_academy407" };
    },
    createPayment: async (payload) => {
      calls.push(["payment", payload]);
      return {
        id: "pay_academy6001",
        status: "PENDING",
        billingType: "PIX",
        value: 1248.5,
        dueDate: "2026-07-29",
        description: "CPA 2026 + ANCORD 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/6001",
      };
    },
    updatePayment: async (id, payload) => {
      calls.push(["update", id, payload]);
      return { id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6001" };
    },
    getPixQrCode: async (id) => {
      calls.push(["pix", id]);
      return { encodedImage: "aW1hZ2U=", payload: "000201ACADEMY4U", expirationDate: "2026-07-29" };
    },
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa", "ancord-2026"],
      couponCode: null,
      buyer: buyer(),
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_academy6001",
    status: "open",
    method: "pix",
    installments: 1,
    installmentCents: 124_850,
    totalCents: 124_850,
    pix: { qrCodeBase64: "aW1hZ2U=", emv: "000201ACADEMY4U", expiresAt: "2026-07-29" },
  });
  const payment = calls.find(([name]) => name === "payment")[1];
  assert.equal(payment.billingType, "PIX");
  assert.equal(payment.value, 1248.5);
  assert.match(payment.externalReference, /^academy:/);
  const callbackUpdate = calls.find(([name]) => name === "update")[2];
  assert.deepEqual(callbackUpdate, {
    billingType: "PIX",
    value: 1248.5,
    dueDate: "2026-07-29",
    callback: {
      successUrl: "https://academy4u.com.br/checkout/sucesso/?order_id=pay_academy6001",
      autoRedirect: true,
    },
    description: "CPA 2026 + ANCORD 2026",
    externalReference: payment.externalReference,
  });
});

test("creates a finite Pix installment plan without increasing the customer total", async (context) => {
  const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_pix_plan407" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => {
      calls.push(["payment", payload]);
      return {
        id: "pay_pixplan6003",
        installment: "ins_pixplan6003",
        status: "PENDING",
        billingType: "PIX",
        value: 250,
        dueDate: "2026-07-29",
        description: "CPA 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/6003",
      };
    },
    updatePayment: async (id, payload) => {
      calls.push(["update", id, payload]);
      return { id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6003" };
    },
    getPixQrCode: async () => ({
      encodedImage: "aW1hZ2U=",
      payload: "000201ACADEMY4UPARCELADO",
      expirationDate: "2026-07-29",
    }),
    listInstallmentPayments: async () => ({ data: [] }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: buyer(),
      payment: { method: "pix_installment", installments: 3 },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_pixplan6003",
    status: "open",
    method: "pix_installment",
    installments: 3,
    installmentCents: 25_000,
    totalCents: 75_000,
    pix: {
      qrCodeBase64: "aW1hZ2U=",
      emv: "000201ACADEMY4UPARCELADO",
      expiresAt: "2026-07-29",
    },
  });
  const payment = calls.find(([name]) => name === "payment")[1];
  assert.equal(payment.billingType, "PIX");
  assert.equal(payment.installmentCount, 3);
  assert.equal(payment.totalValue, 750);
  assert.equal("value" in payment, false);
});

test("recovers a Pix QR Code without creating a second charge", async (context) => {
  let paymentCalls = 0;
  let qrCalls = 0;
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_pix_recovery" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => {
      paymentCalls += 1;
      return {
        id: "pay_pix_recovery",
        status: "PENDING",
        billingType: "PIX",
        value: 750,
        dueDate: "2026-07-29",
        description: "CPA 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/recovery",
      };
    },
    updatePayment: async (id) => ({
      id,
      status: "PENDING",
      billingType: "PIX",
      value: 750,
      dueDate: "2026-07-29",
      invoiceUrl: "https://sandbox.asaas.com/i/recovery",
    }),
    getPayment: async (id) => ({ id, status: "PENDING" }),
    getPixQrCode: async () => {
      qrCalls += 1;
      if (qrCalls === 1) throw Object.assign(new Error("not ready"), { status: 404 });
      return { encodedImage: "aW1hZ2U=", payload: "000201RECOVERED", expirationDate: "2026-07-29" };
    },
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: cardBuyer(),
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_pix_recovery",
    status: "open",
    method: "pix",
    installments: 1,
    installmentCents: 75_000,
    totalCents: 75_000,
    pixPending: true,
  });

  const recovery = await fetch(`${origin}/v1/checkout/orders/pay_pix_recovery/pix`);
  assert.equal(recovery.status, 200);
  assert.deepEqual(await recovery.json(), {
    id: "pay_pix_recovery",
    status: "open",
    pix: {
      qrCodeBase64: "aW1hZ2U=",
      emv: "000201RECOVERED",
      expiresAt: "2026-07-29",
    },
  });
  assert.equal(paymentCalls, 1);
  assert.equal(qrCalls, 2);
});

test("creates a ten-installment embedded card payment without exposing a redirect", async (context) => {
  const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_existing407" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => {
      calls.push(payload);
      return {
        id: "pay_academy6002",
        status: "PENDING",
        billingType: "CREDIT_CARD",
        value: 75,
        dueDate: "2026-07-29",
        description: "CPA 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/6002",
      };
    },
    updatePayment: async (id, payload) => {
      calls.push(payload);
      return { id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6002" };
    },
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: cardBuyer(),
      payment: {
        method: "credit_card",
        installments: 10,
        card: {
          holderName: "VICTOR CRONEMBERGER",
          number: "4444444444444444",
          expiryMonth: "12",
          expiryYear: "2030",
          ccv: "123",
        },
      },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_academy6002",
    status: "open",
    method: "credit_card",
    installments: 10,
    installmentCents: 7_500,
    totalCents: 75_000,
    message: "Pagamento recebido e em análise.",
  });
  assert.equal(calls[0].billingType, "CREDIT_CARD");
  assert.equal(calls[0].installmentCount, 10);
  assert.equal(calls[0].totalValue, 750);
  assert.equal("value" in calls[0], false);
  assert.deepEqual(calls[0].creditCard, {
    holderName: "VICTOR CRONEMBERGER",
    number: "4444444444444444",
    expiryMonth: "12",
    expiryYear: "2030",
    ccv: "123",
  });
  assert.equal(calls[0].remoteIp, "127.0.0.1");
  assert.deepEqual(calls[1], {
    billingType: "CREDIT_CARD",
    value: 75,
    dueDate: "2026-07-29",
    callback: {
      successUrl: "https://academy4u.com.br/checkout/sucesso/?order_id=pay_academy6002",
      autoRedirect: true,
    },
    description: "CPA 2026",
    externalReference: calls[0].externalReference,
  });
});

test("returns card terms separately without claiming Pix is interest-free", async (context) => {
  const origin = await serve(context, enabledEnvironment, { asaasClient: {} });
  const response = await fetch(`${origin}/v1/checkout/installments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: null }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.maximumInstallments, 10);
  assert.equal(result.maximumPixInstallments, 6);
  assert.equal(result.cardInterestFree, true);
  assert.equal(result.pixTotalPreserved, true);
  assert.equal(result.installments.length, 10);
  assert.equal(result.cardInstallments.length, 10);
  assert.equal(result.pixInstallments.length, 5);
  assert.deepEqual(result.pixInstallments[0], {
    number: 2,
    totalCents: 75_000,
    installmentCents: 37_500,
    lastInstallmentCents: 37_500,
    installmentAmountsCents: [37_500, 37_500],
  });
});

test("rejects Pix installment plans above six installments", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: buyer(),
      payment: { method: "pix_installment", installments: 7 },
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_installments");
});

test("rejects malformed birth date or address before calling Asaas", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  for (const badBuyer of [
    { ...buyer(), birthDate: "10/05/1985" },
    { ...buyer(), birthDate: "2035-01-01" },
    { ...buyer(), address: { postCode: "1300" } },
    { ...buyer(), address: { state: "XX" } },
  ]) {
    const response = await fetch(`${origin}/v1/checkout/orders`, {
      method: "POST",
      headers: trustedHeaders(),
      body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: null, buyer: badBuyer, payment: { method: "pix" } }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /invalid_birth_date|invalid_address/);
  }
});

test("persists full buyer identity for later reconciliation", async (context) => {
  const store = createInMemoryStore();
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_full_buyer" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => ({
      id: "pay_full_buyer",
      status: "PENDING",
      billingType: "PIX",
      value: 750,
      dueDate: "2026-07-29",
      description: "CPA 2026",
      externalReference: payload.externalReference,
      invoiceUrl: "https://sandbox.asaas.com/i/fullbuyer",
    }),
    updatePayment: async (id) => ({ id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/fullbuyer" }),
    getPixQrCode: async () => ({ encodedImage: "aW1hZ2U=", payload: "000201FULL" }),
  };
  const origin = await serve(context, enabledEnvironment, { store, asaasClient });
  const address = {
    postCode: "13000000",
    street: "Rua das Palmas",
    number: "45",
    complement: "Apto 71",
    district: "Jardim",
    city: "Campinas",
    state: "SP",
  };
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: { ...buyer(), birthDate: "1985-05-10", address },
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  const [listed] = await store.listOrders({ limit: 1 });
  const stored = await store.getOrderWithItems(listed.id);
  assert.equal(stored.buyerBirthDate, "1985-05-10");
  assert.deepEqual(stored.buyerAddress, address);
  assert.equal(stored.buyerPhone, "11999999999");
});

test("rejects invalid CPF or CNPJ before calling Asaas", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: { ...buyer(), documentNumber: "45487468111" },
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_document",
    message: "CPF ou CNPJ inválido.",
    retryable: true,
  });
});

test("rejects coupons that reduce a Pix charge below the Asaas minimum", async (context) => {
  const store = createInMemoryStore();
  await store.saveCoupon({
    code: "QUASE100",
    discountBps: 9_999,
    active: true,
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    productSlugs: ["novo-cpa"],
  });
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { store, asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: "QUASE100",
      buyer: buyer(),
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "payment_amount_below_minimum",
    message: "O valor mínimo para pagamento por Pix é R$ 10,00. Ajuste o cupom ou adicione outro curso.",
    retryable: true,
  });
});

test("rejects raw card fields and invalid catalog data before calling Asaas", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  for (const payload of [
    { slugs: ["produto-inventado"], couponCode: null, buyer: buyer(), payment: { method: "pix" } },
    { slugs: ["novo-cpa"], couponCode: "DESCONTO100", buyer: buyer(), payment: { method: "pix" } },
    { slugs: ["novo-cpa"], couponCode: null, buyer: buyer(), payment: { method: "boleto", installments: 1 } },
    {
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: buyer(),
      payment: {
        method: "credit_card",
        number: "4000000000000010",
        cvv: "123",
        installments: 0,
      },
    },
  ]) {
    const response = await fetch(`${origin}/v1/checkout/orders`, {
      method: "POST",
      headers: trustedHeaders(),
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }
});

test("allows a safe retry with the same idempotency key before an Asaas charge exists", async (context) => {
  let customerCalls = 0;
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [] }),
    createCustomer: async () => {
      customerCalls += 1;
      if (customerCalls === 1) throw Object.assign(new Error("temporary"), { retryable: true });
      return { id: "cus_retry409" };
    },
    createPayment: async () => ({ id: "pay_retry6010", status: "PENDING" }),
    updatePayment: async (id) => ({ id, status: "PENDING" }),
    getPixQrCode: async () => ({ encodedImage: "aW1hZ2U=", payload: "000201RETRY" }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const key = crypto.randomUUID();
  const payload = { slugs: ["novo-cpa"], couponCode: null, buyer: buyer(), payment: { method: "pix" } };
  const first = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST", headers: trustedHeaders(key), body: JSON.stringify(payload),
  });
  assert.equal(first.status, 502);
  const second = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST", headers: trustedHeaders(key), body: JSON.stringify(payload),
  });
  assert.equal(second.status, 201);
  assert.equal((await second.json()).orderId, "pay_retry6010");
  assert.equal(customerCalls, 2);
});

test("does not let status polling consume the charge creation limit", async (context) => {
  let paymentSequence = 0;
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_polling" }] }),
    createPayment: async (payload) => {
      paymentSequence += 1;
      return {
        id: `pay_polling_${paymentSequence}`,
        status: "PENDING",
        billingType: "PIX",
        value: 498.5,
        dueDate: "2026-08-09",
        externalReference: payload.externalReference,
      };
    },
    updatePayment: async (id) => ({ id, status: "PENDING" }),
    getPayment: async (id) => ({ id, status: "PENDING" }),
    getPixQrCode: async () => ({ encodedImage: "aW1hZ2U=", payload: "000201POLLING" }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const payload = JSON.stringify({
    slugs: ["novo-cpa"],
    couponCode: null,
    buyer: buyer(),
    payment: { method: "pix" },
  });
  const first = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: payload,
  });
  assert.equal(first.status, 201);
  const firstOrderId = (await first.json()).orderId;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await fetch(`${origin}/v1/checkout/orders/${firstOrderId}`);
    assert.equal(status.status, 200);
  }

  const second = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: payload,
  });
  assert.equal(second.status, 201);
  assert.equal((await second.json()).orderId, "pay_polling_2");
});

test("quotes an LMS coupon without exposing another payment method", async (context) => {
  const store = createInMemoryStore();
  store.authenticateCheckoutToken = async (token) => token === "8|quote-token"
    ? { kind: "sanctum", tokenId: 8, userId: 41 }
    : null;
  store.createLmsCheckoutQuote = async ({ userId, recipientUserId, courseIds, couponCode }) => {
    assert.deepEqual({ userId, recipientUserId, courseIds, couponCode }, {
      userId: 41,
      recipientUserId: 41,
      courseIds: [8],
      couponCode: "APROVA10",
    });
    return {
      lms: true,
      recipientUserId: 41,
      couponCode: "APROVA10",
      subtotalCents: 59_700,
      discountCents: 5_970,
      totalCents: 53_730,
      lines: [],
    };
  };
  const origin = await serve(context, enabledEnvironment, { store, asaasClient: {} });
  const response = await fetch(`${origin}/v1/checkout/installments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer 8|quote-token",
    },
    body: JSON.stringify({
      courseIds: [8],
      recipientUserId: 41,
      couponCode: "APROVA10",
    }),
  });
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.deepEqual({
    couponCode: quote.couponCode,
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    totalCents: quote.totalCents,
  }, { couponCode: "APROVA10", subtotalCents: 59_700, discountCents: 5_970, totalCents: 53_730 });
});

test("accepts a one-use Sanctum checkout token for an embedded LMS card payment", async (context) => {
  const store = createInMemoryStore();
  let revokedTokenId = null;
  store.authenticateCheckoutToken = async (token) => token === "7|checkout-token"
    ? { kind: "sanctum", tokenId: 7, userId: 41 }
    : null;
  store.revokeCheckoutToken = async (tokenId) => { revokedTokenId = tokenId; };
  store.createLmsCheckoutQuote = async ({ userId, recipientUserId, courseIds }) => {
    assert.equal(userId, 41);
    assert.equal(recipientUserId, 42);
    assert.deepEqual(courseIds, [8]);
    return {
      lms: true,
      recipientUserId: 42,
      couponCode: null,
      subtotalCents: 59_700,
      discountCents: 0,
      totalCents: 59_700,
      lines: [{
        product: { slug: "preparatorio-ancord-agentes-autonomos", title: "Preparatório ANCORD", courseId: 8 },
        basePriceCents: 59_700,
        discountCents: 0,
        finalPriceCents: 59_700,
      }],
    };
  };
  let paymentPayload;
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_lms_card" }] }),
    createPayment: async (payload) => {
      paymentPayload = payload;
      return {
        id: "pay_lms_card01",
        status: "CONFIRMED",
        billingType: "CREDIT_CARD",
        value: 597,
        dueDate: "2026-08-09",
        description: "Preparatório ANCORD",
        externalReference: payload.externalReference,
      };
    },
    updatePayment: async (id) => ({ id, status: "CONFIRMED" }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient, store });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer 7|checkout-token",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      courseIds: [8],
      recipientUserId: 42,
      buyer: cardBuyer(),
      payment: {
        method: "credit_card",
        installments: 3,
        card: { holderName: "VICTOR CRONEMBERGER", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" },
      },
    }),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.orderId, "pay_lms_card01");
  assert.equal(result.status, "paid");
  assert.equal("redirectUrl" in result, false);
  assert.equal(paymentPayload.billingType, "CREDIT_CARD");
  assert.equal(paymentPayload.creditCard.ccv, "123");
  assert.equal(paymentPayload.remoteIp, "127.0.0.1");
  assert.equal(revokedTokenId, 7);
});

test("authenticates and deduplicates Asaas payment webhooks", async (context) => {
  const origin = await serve(context, enabledEnvironment, { asaasClient: {} });
  const event = {
    id: "evt_payment_6001&17558216",
    event: "PAYMENT_CONFIRMED",
    payment: {
      id: "pay_academy6001",
      status: "CONFIRMED",
      externalReference: "academy:attempt-6001",
    },
  };
  const rejected = await fetch(`${origin}/v1/webhooks/asaas`, {
    method: "POST",
    headers: { "content-type": "application/json", "asaas-access-token": "wrong" },
    body: JSON.stringify(event),
  });
  assert.equal(rejected.status, 401);

  for (const duplicate of [false, true]) {
    const response = await fetch(`${origin}/v1/webhooks/asaas`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "asaas-access-token": enabledEnvironment.ASAAS_WEBHOOK_TOKEN,
      },
      body: JSON.stringify(event),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, duplicate });
  }
});

test("returns only a sanitized payment status to the storefront", async (context) => {
  const asaasClient = {
    getPayment: async (id) => ({
      id,
      status: "CONFIRMED",
      customer: "cus_private",
      creditCard: { creditCardNumber: "8829" },
    }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders/pay_academy6001`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "pay_academy6001", status: "paid" });
});
