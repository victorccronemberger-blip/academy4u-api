import assert from "node:assert/strict";

const apiOrigin = String(process.env.GALATIC_AUDIT_API_ORIGIN || "https://api.academy4u.com.br").replace(/\/$/, "");
const storefrontOrigin = String(process.env.GALATIC_AUDIT_STOREFRONT_ORIGIN || "https://galatic.com.br").replace(/\/$/, "");
const sku = String(process.env.GALATIC_AUDIT_SKU || "DEP001").trim().toUpperCase();
const postalCode = String(process.env.GALATIC_AUDIT_POSTAL_CODE || "06020190").replace(/\D/g, "");
const environmentArg = process.argv.find((argument) => argument.startsWith("--environment="));
const expectedPaymentEnvironment = String(
  environmentArg?.split("=")[1] || process.env.GALATIC_AUDIT_EXPECTED_ENVIRONMENT || "production",
).trim().toLowerCase();
assert.ok(["sandbox", "production"].includes(expectedPaymentEnvironment), "ambiente de auditoria inválido");
const headers = { accept: "application/json", origin: storefrontOrigin };

async function request(path, options = {}) {
  const response = await fetch(`${apiOrigin}${path}`, {
    ...options,
    headers: { ...headers, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const checkout = await request("/v1/galatic/checkout/status");
assert.equal(checkout.response.status, 200, "status do checkout indisponível");
assert.equal(checkout.body.enabled, true, "checkout desabilitado");
assert.equal(
  checkout.body.environment,
  expectedPaymentEnvironment,
  `Asaas não está no ambiente esperado: ${expectedPaymentEnvironment}`,
);
assert.deepEqual(checkout.body.methods, ["pix", "credit_card"], "métodos de pagamento divergentes");
assert.equal(checkout.body.cardMode, "embedded_api", "cartão não está embutido");
assert.equal(checkout.body.cardInstallmentMaximum, 10, "limite de parcelas divergente");
assert.equal(checkout.body.cardInterest, "asaas_fees_passed_to_customer", "taxas não estão sendo repassadas");
assert.equal(checkout.body.pixInstallment, false, "Pix parcelado foi habilitado indevidamente");

const shipping = await request("/v1/galatic/shipping/status");
assert.equal(shipping.response.status, 200, "status de frete indisponível");
assert.equal(shipping.body.enabled, true, "Envia desabilitado");
assert.equal(shipping.body.environment, "production", "Envia não está em produção");
assert.equal(shipping.body.labels, true, "etiquetas desabilitadas");
assert.equal(shipping.body.tracking, true, "rastreio desabilitado");

const items = [{ sku, quantity: 1 }];
const quote = await request("/v1/galatic/quote", {
  method: "POST",
  body: JSON.stringify({ items, postalCode }),
});
assert.equal(quote.response.status, 200, `cotação de frete falhou: ${JSON.stringify(quote.body)}`);
assert.ok(Array.isArray(quote.body.quotes) && quote.body.quotes.length > 0, "nenhuma opção de frete retornada");
const selectedQuote = quote.body.quotes[0];
assert.match(String(selectedQuote.quote_id || ""), /^[0-9a-f-]{36}$/i, "identificador de frete inválido");
assert.ok(Number(selectedQuote.amount) > 0, "frete sem preço");

const preview = await request("/v1/galatic/checkout/installments", {
  method: "POST",
  body: JSON.stringify({ items, shipping: { quoteId: selectedQuote.quote_id }, buyerEmail: "auditoria@galatic.com.br" }),
});
assert.equal(preview.response.status, 200, `simulação de parcelas falhou: ${JSON.stringify(preview.body)}`);
assert.ok(Number(preview.body.pix?.totalCents) > 0, "total Pix inválido");
assert.equal(preview.body.card?.length, 10, "o cartão não retornou exatamente 10 planos");
assert.deepEqual(preview.body.card.map((plan) => plan.installments), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.ok(preview.body.card.every((plan) => Number(plan.totalCents) >= Number(preview.body.pix.totalCents)), "taxa do cartão inconsistente");

const buyer = {
  firstName: "Auditoria", lastName: "Galatic", email: `auditoria+${Date.now()}@galatic.com.br`,
  phone: "15997671749", documentNumber: "19100000000",
  address: { postal_code: postalCode, street: "Avenida Franz Voegeli", number: "501", district: "Parque Continental", city: "Osasco", state: "SP" },
};
for (const method of ["boleto", "cash", "pix_installment"]) {
  const forbidden = await request("/v1/galatic/checkout/orders", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ items, buyer, shipping: { quoteId: selectedQuote.quote_id }, payment: { method } }),
  });
  assert.equal(forbidden.response.status, 400, `${method} não foi bloqueado`);
  assert.equal(forbidden.body.error, "invalid_payment_method", `${method} retornou erro inesperado`);
}

const excessiveInstallments = await request("/v1/galatic/checkout/orders", {
  method: "POST",
  headers: { "idempotency-key": crypto.randomUUID() },
  body: JSON.stringify({ items, buyer, shipping: { quoteId: selectedQuote.quote_id }, payment: { method: "credit_card", installments: 11 } }),
});
assert.equal(excessiveInstallments.response.status, 400, "cartão acima de 10x não foi bloqueado");
assert.equal(excessiveInstallments.body.error, "invalid_installments");

console.log(JSON.stringify({
  ok: true,
  environment: checkout.body.environment,
  paymentMethods: checkout.body.methods,
  cardInstallments: preview.body.card.length,
  shipping: { provider: quote.body.provider, service: selectedQuote.service, amount: selectedQuote.amount, estimatedDays: selectedQuote.estimated_days },
  forbiddenMethods: ["boleto", "cash", "pix_installment"],
}, null, 2));
