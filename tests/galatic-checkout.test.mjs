import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

function store() {
  const state = { attached: null, completed: null, prepared: null };
  return {
    state,
    ensureSchema: async () => {}, close: async () => {},
    previewCheckout: async () => ({ subtotalCents: 44999, shippingCents: 2500, discountCents: 0, couponCode: null, totalCents: 47499 }),
    prepareOrder: async (input) => { state.prepared = input; return { kind: "created", order: { id: "52c02ff3-b755-4df5-90ba-20ea8c8bd035", subtotalCents: 44999, shippingCents: 2500, totalCents: 47499, lines: [{ sku: "DEP001", title: "Deep Regrets", quantity: 1, unitAmountCents: 44999 }] } }; },
    beginPaymentCreation: async (...args) => { state.operation = args; },
    markPaymentCreationUncertain: async () => {},
    attachPayment: async (...args) => { state.attached = args; },
    completeCheckoutAttempt: async (...args) => { state.completed = args; },
    releaseFailedOrder: async () => assert.fail("order should not be released"),
    getOrderByPublicId: async () => null,
    updateOrderFromWebhook: async () => ({ deferred: true }),
  };
}

test("previews all Galatic card installments with the live Asaas fee table", async (context) => {
  const galaticStore = store();
  const simulated = [];
  const asaasClient = { simulatePayment: async (payload) => {
    simulated.push(payload);
    return { creditCard: { feePercentage: payload.installmentCount === 10 ? 4.49 : 2.99, operationFee: 0.49 } };
  }, getAccountFees: async () => ({ payment: { creditCard: {
    operationValue: 0.49, oneInstallmentPercentage: 2.99,
    upToSixInstallmentsPercentage: 3.49, upToTwelveInstallmentsPercentage: 4.49,
  } } }) };
  const { app } = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" },
  { stores: { galatic: galaticStore }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/galatic/checkout/installments`, { method: "POST",
    headers: { "content-type": "application/json", origin: "https://galatic.com.br" },
    body: JSON.stringify({ items: [{ sku: "DEP001", quantity: 1 }],
      shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" } }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.pix.totalCents, 47499);
  assert.equal(body.card.length, 10);
  assert.equal(body.card[0].installments, 1);
  assert.equal(body.card[9].installments, 10);
  assert.equal(body.card[0].source, "galatic_interest_free_1x");
  assert.equal(body.card[0].percentage, 0);
  assert.equal(body.card[0].feeCents, 0);
  assert.equal(body.card[0].totalCents, 47499);
  assert.equal(simulated.length, 9);
  assert.deepEqual(simulated[8], { value: 474.99, installmentCount: 10, billingTypes: ["CREDIT_CARD"] });
  assert.equal(body.card[9].totalCents, Math.ceil((47499 + 49) / (1 - 0.0449)));
});

test("creates a server-priced Galatic Pix order with a project-scoped reference", async (context) => {
  const galaticStore = store(); const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [] }),
    createCustomer: async () => ({ id: "cus_galatic_1" }),
    createPayment: async (payload) => { calls.push(payload); return { ...payload, id: "pay_galatic_1", status: "PENDING", dueDate: payload.dueDate }; },
    updatePayment: async () => ({ id: "pay_galatic_1", status: "PENDING" }),
    getPixQrCode: async () => ({ encodedImage: "aW1hZ2U=", payload: "000201GALATIC", expirationDate: "2026-08-15" }),
  };
  const { app } = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
    GALATIC_SUCCESS_ORIGIN: "https://galatic.com.br" }, { stores: { galatic: galaticStore }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve)); const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/galatic/checkout/orders`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ items: [{ sku: "DEP001", quantity: 1 }], buyer: { firstName: "Victor", lastName: "Cronemberger",
      email: "victor@example.com", phone: "15997671749", documentNumber: "19100000000",
      address: { postal_code: "06020190", street: "Avenida Franz Voegeli", number: "501", district: "Parque Continental", city: "Osasco", state: "SP" } },
      shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" }, couponCode: " MESA10 ", payment: { method: "pix" } }),
  });
  assert.equal(response.status, 201); const body = await response.json();
  assert.equal(body.orderId, "52c02ff3-b755-4df5-90ba-20ea8c8bd035"); assert.equal(body.totalCents, 47499);
  assert.equal(calls[0].value, 474.99); assert.equal(calls[0].externalReference, "galatic:52c02ff3-b755-4df5-90ba-20ea8c8bd035");
  assert.equal(galaticStore.state.prepared.couponCode, "MESA10");
  assert.deepEqual(galaticStore.state.attached, ["52c02ff3-b755-4df5-90ba-20ea8c8bd035", "pay_galatic_1", "open", {
    method: "pix", installments: 1, installmentAmountCents: 47499, paymentFeeCents: 0, totalCents: 47499, providerGroupId: null,
  }]);
});

test("creates an embedded Galatic card order in up to 10x and passes through the account Asaas fee", async (context) => {
  const galaticStore = store(); const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_galatic_card" }] }),
    getAccountFees: async () => ({ payment: { creditCard: {
      operationValue: 0.49, oneInstallmentPercentage: 2.99,
      upToSixInstallmentsPercentage: 2.99, upToTwelveInstallmentsPercentage: 2.99,
    } } }),
    createPayment: async (payload) => { calls.push(payload); return { ...payload, value: payload.totalValue / payload.installmentCount, id: "pay_galatic_card", installment: "ins_galatic_card", status: "CONFIRMED" }; },
  };
  const { app } = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" },
  { stores: { galatic: galaticStore }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/galatic/checkout/orders`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ items: [{ sku: "DEP001", quantity: 1 }], buyer: { firstName: "Victor", lastName: "Cronemberger",
      email: "victor@example.com", phone: "15997671749", documentNumber: "19100000000",
      address: { postal_code: "06020190", street: "Avenida Franz Voegeli", number: "501", district: "Parque Continental", city: "Osasco", state: "SP" } },
      shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" }, payment: { method: "credit_card", installments: 10,
        card: { holderName: "Victor Cronemberger", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" } } }),
  });
  assert.equal(response.status, 201); const body = await response.json();
  const expectedTotal = Math.ceil((47499 + 49) / (1 - 0.0299));
  assert.equal(body.method, "credit_card"); assert.equal(body.installments, 10); assert.equal(body.totalCents, expectedTotal);
  assert.equal(calls[0].billingType, "CREDIT_CARD"); assert.equal(calls[0].installmentCount, 10);
  assert.equal(calls[0].totalValue, expectedTotal / 100); assert.equal(calls[0].creditCard.number, "4444444444444444");
  assert.equal(JSON.stringify(body).includes("4444444444444444"), false);
});

test("creates a Galatic card order in 1x without charging the Asaas fee to the customer", async (context) => {
  const galaticStore = store(); const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_galatic_card_1x" }] }),
    simulatePayment: async () => assert.fail("1x interest-free must not request a customer fee"),
    createPayment: async (payload) => { calls.push(payload); return { ...payload, id: "pay_galatic_card_1x", status: "CONFIRMED" }; },
  };
  const { app } = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" },
  { stores: { galatic: galaticStore }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/galatic/checkout/orders`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ items: [{ sku: "DEP001", quantity: 1 }], buyer: { firstName: "Victor", lastName: "Cronemberger",
      email: "victor@example.com", phone: "15997671749", documentNumber: "19100000000",
      address: { postal_code: "06020190", street: "Avenida Franz Voegeli", number: "501", district: "Parque Continental", city: "Osasco", state: "SP" } },
      shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" }, payment: { method: "credit_card", installments: 1,
        card: { holderName: "Victor Cronemberger", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" } } }),
  });
  assert.equal(response.status, 201); const body = await response.json();
  assert.equal(body.totalCents, 47499); assert.equal(body.baseTotalCents, 47499); assert.equal(body.cardFeeCents, 0);
  assert.equal(calls[0].value, 474.99); assert.equal("installmentCount" in calls[0], false);
  assert.equal(galaticStore.state.attached[3].paymentFeeCents, 0);
  assert.equal(galaticStore.state.attached[3].totalCents, 47499);
});

test("rejects every forbidden Galatic payment method and card plans above 10x before touching Asaas", async (context) => {
  let providerCalls = 0;
  const galaticStore = store();
  const asaasClient = {
    findCustomersByDocument: async () => { providerCalls += 1; return { data: [] }; },
    createCustomer: async () => { providerCalls += 1; return { id: "unexpected" }; },
    createPayment: async () => { providerCalls += 1; return { id: "unexpected" }; },
  };
  const { app } = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" },
  { stores: { galatic: galaticStore }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const checkout = async (payment) => fetch(`http://127.0.0.1:${server.address().port}/v1/galatic/checkout/orders`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ items: [{ sku: "DEP001", quantity: 1 }], buyer: { firstName: "Victor", lastName: "Cronemberger",
      email: "victor@example.com", phone: "15997671749", documentNumber: "19100000000",
      address: { postal_code: "06020190", street: "Avenida Franz Voegeli", number: "501", district: "Parque Continental", city: "Osasco", state: "SP" } },
      shipping: { quoteId: "93b448ca-3dcc-43cd-9d14-02e14745695f" }, payment }),
  });

  for (const method of ["boleto", "cash", "pix_installment"]) {
    const response = await checkout({ method, installments: 2 });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_payment_method");
  }
  const excessiveCard = await checkout({ method: "credit_card", installments: 11, card: {} });
  assert.equal(excessiveCard.status, 400);
  assert.equal((await excessiveCard.json()).error, "invalid_installments");
  assert.equal(providerCalls, 0);
  assert.equal(galaticStore.state.attached, null);
});

test("rejects quantities above three and duplicate SKU aggregation before touching Asaas", async (context) => {
  let providerCalls = 0;
  const galaticStore = store();
  const asaasClient = {
    findCustomersByDocument: async () => { providerCalls += 1; return { data: [] }; },
    createCustomer: async () => { providerCalls += 1; return { id: "unexpected" }; },
  };
  const { app } = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox", ASAAS_SANDBOX: "$aact_test",
    PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br" },
  { stores: { galatic: galaticStore }, asaasClient });
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const checkout = async (items) => fetch(`http://127.0.0.1:${server.address().port}/v1/galatic/checkout/orders`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ items, payment: { method: "pix" } }),
  });

  assert.equal((await checkout([{ sku: "DEP001", quantity: 4 }])).status, 400);
  const duplicate = await checkout([{ sku: "DEP001", quantity: 2 }, { sku: "DEP001", quantity: 2 }]);
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error, "item_quantity_limit");
  assert.equal(providerCalls, 0);
});
