import { createGalaticPaymentRecovery } from "../services/galatic-payment-recovery.js";
import { galaticPaymentResponse, matchesGalaticPayment } from "../domain/galatic-payment.js";
import { galaticPostcode } from "../domain/galatic-address.js";
import { createHash } from "node:crypto";
import { normalizeBrazilianTaxId } from "../domain/brazilian-tax-id.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";
import { CreditCardInputError, cardHolderInfo, parseCreditCard } from "../domain/credit-card.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import { allowBodyFields } from "../http/request-security.js";

class GalaticInputError extends Error {
  constructor(message, code = "invalid_checkout") { super(message); this.code = code; }
}

const MAX_ITEM_QUANTITY = 3;

function exactObject(value, fields, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new GalaticInputError(`${label} inválido.`);
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new GalaticInputError(`${label} contém campos não permitidos.`, "unexpected_fields");
  }
  return value;
}

function text(value, min, max, label) {
  const result = String(value ?? "").trim().replace(/\s+/g, " ");
  if (result.length < min || result.length > max) throw new GalaticInputError(`${label} inválido.`);
  return result;
}
function digits(value, min, max, label) {
  const result = String(value ?? "").replace(/\D/g, "");
  if (result.length < min || result.length > max) throw new GalaticInputError(`${label} inválido.`);
  return result;
}
function items(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new GalaticInputError("Carrinho inválido.");
  const quantities = new Map();
  for (const item of input) {
    exactObject(item, ["sku", "slug", "quantity"], "Item");
    const key = String(item?.sku ?? item?.slug ?? "").trim();
    const quantity = Number(item?.quantity);
    if (!/^[A-Za-z0-9_-]{2,100}$/.test(key) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
      throw new GalaticInputError("Item inválido no carrinho.");
    }
    const total = (quantities.get(key) ?? 0) + quantity;
    if (total > MAX_ITEM_QUANTITY) {
      throw new GalaticInputError(`O limite é de ${MAX_ITEM_QUANTITY} unidades por produto.`, "item_quantity_limit");
    }
    quantities.set(key, total);
  }
  return [...quantities].map(([key, quantity]) => ({ key, quantity }));
}
function buyer(input) {
  exactObject(input, ["firstName", "lastName", "email", "phone", "documentNumber", "address"], "Comprador");
  const firstName = text(input?.firstName, 2, 80, "Nome");
  const lastName = text(input?.lastName, 2, 100, "Sobrenome");
  const email = String(input?.email ?? "").trim().toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GalaticInputError("E-mail inválido.");
  const address = input?.address;
  exactObject(address, ["postCode", "postalCode", "postal_code", "cep", "street", "logradouro", "number", "numero",
    "complement", "complemento", "district", "bairro", "city", "cidade", "state", "uf"], "Endereço");
  const state = text(address.state ?? address.uf, 2, 2, "UF").toUpperCase();
  const normalizedAddress = {
    postCode: digits(galaticPostcode(address), 8, 8, "CEP"),
    street: text(address.street ?? address.logradouro, 2, 160, "Logradouro"),
    number: text(address.number ?? address.numero, 1, 20, "Número"),
    complement: String(address.complement ?? address.complemento ?? "").trim().slice(0, 160),
    district: text(address.district ?? address.bairro, 2, 120, "Bairro"),
    city: text(address.city ?? address.cidade, 2, 120, "Cidade"), state,
  };
  const document = normalizeBrazilianTaxId(input?.documentNumber);
  if (!document) throw new GalaticInputError("CPF ou CNPJ inválido.");
  return { firstName, lastName, name: `${firstName} ${lastName}`, email,
    phone: digits(input?.phone, 10, 13, "Telefone"), document, address: normalizedAddress };
}
function uuid(request) {
  const key = request.get("Idempotency-Key")?.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key ?? "")) {
    throw new GalaticInputError("Identificador da tentativa inválido.", "invalid_idempotency_key");
  }
  return key;
}
function asaasCustomer(buyer) {
  return { name: buyer.name, email: buyer.email, mobilePhone: buyer.phone, cpfCnpj: buyer.document,
    postalCode: buyer.address.postCode, address: buyer.address.street, addressNumber: buyer.address.number,
    complement: buyer.address.complement || undefined, province: buyer.address.district };
}
async function customerId(client, buyer) {
  const existing = await client.findCustomersByDocument(buyer.document);
  if (existing?.data?.[0]?.id) return existing.data[0].id;
  return (await client.createCustomer(asaasCustomer(buyer)))?.id;
}
function pix(result) {
  if (!result?.encodedImage || !result?.payload) return null;
  return { qrCodeBase64: result.encodedImage, emv: result.payload, expiresAt: result.expirationDate ?? null };
}

function payment(input) {
  exactObject(input, ["method", "installments", "card"], "Pagamento");
  if (input?.method === "pix") return { method: "pix", installments: 1, card: null };
  if (input?.method !== "credit_card") throw new GalaticInputError("Escolha Pix ou cartão de crédito.", "invalid_payment_method");
  const installments = Number(input.installments ?? 1);
  if (!Number.isSafeInteger(installments) || installments < 1 || installments > 10) {
    throw new GalaticInputError("Escolha de 1 a 10 parcelas.", "invalid_installments");
  }
  return { method: "credit_card", installments, card: parseCreditCard(input.card) };
}

function activeRate(cardFees, installments) {
  const discounted = cardFees?.discountExpiration && Date.parse(cardFees.discountExpiration) > Date.now();
  const prefix = discounted ? "discount" : "";
  const key = installments === 1
    ? `${prefix}${prefix ? "One" : "one"}InstallmentPercentage`
    : installments <= 6
      ? `${prefix}${prefix ? "Up" : "up"}ToSixInstallmentsPercentage`
      : `${prefix}${prefix ? "Up" : "up"}ToTwelveInstallmentsPercentage`;
  const direct = Number(cardFees?.[key]);
  if (Number.isFinite(direct) && direct >= 0 && direct < 30) return direct;
  const fallbackKey = installments === 1 ? "oneInstallmentPercentage" : installments <= 6 ? "upToSixInstallmentsPercentage" : "upToTwelveInstallmentsPercentage";
  const fallback = Number(cardFees?.[fallbackKey]);
  return Number.isFinite(fallback) && fallback >= 0 && fallback < 30 ? fallback : null;
}

function cardPricing(baseCents, installments, fees) {
  const cardFees = fees?.payment?.creditCard;
  const percentage = activeRate(cardFees, installments);
  const fixedCents = Math.max(0, Math.round(Number(cardFees?.operationValue ?? 0) * 100));
  if (percentage === null) throw new GalaticInputError("As condições do cartão estão temporariamente indisponíveis.", "card_fees_unavailable");
  const totalCents = Math.ceil((baseCents + fixedCents) / (1 - percentage / 100));
  return { baseCents, totalCents, feeCents: totalCents - baseCents, percentage,
    installmentCents: Math.ceil(totalCents / installments) };
}

function simulatedCardPricing(baseCents, installments, simulation) {
  const card = simulation?.creditCard;
  const percentage = Number(card?.feePercentage);
  const fixedCents = Math.max(0, Math.round(Number(card?.operationFee ?? 0) * 100));
  if (!Number.isFinite(percentage) || percentage < 0 || percentage >= 30 || !Number.isFinite(fixedCents)) return null;
  const totalCents = Math.ceil((baseCents + fixedCents) / (1 - percentage / 100));
  return { baseCents, totalCents, feeCents: totalCents - baseCents, percentage,
    installmentCents: Math.ceil(totalCents / installments), source: "asaas_sales_simulator" };
}

export function createGalaticCheckoutRouter(express, { environment, asaasClient, store, notifications = null,
  botChallenge = { verify: (_request, _response, next) => next() } }) {
  const router = express.Router();
  const consume = store.consumeRateLimit?.bind(store);
  const writeLimiter = createFixedWindowLimiter({ windowMs: 60_000, limit: 12, prefix: "galatic-checkout", consume });
  const readLimiter = createFixedWindowLimiter({ windowMs: 60_000, limit: 60, prefix: "galatic-order", consume });
  const recoverPayment = store.getCheckoutRecovery ? createGalaticPaymentRecovery({ store, asaasClient }) : null;
  let feeCache = null;
  const simulationCache = new Map();
  async function accountFees() {
    if (feeCache?.expiresAt > Date.now()) return feeCache.value;
    const value = await asaasClient.getAccountFees();
    feeCache = { value, expiresAt: Date.now() + 15 * 60_000 };
    return value;
  }
  async function providerCardPricing(baseCents, installments) {
    if (installments === 1) {
      return { baseCents, totalCents: baseCents, feeCents: 0, percentage: 0,
        installmentCents: baseCents, source: "galatic_interest_free_1x" };
    }
    const cacheKey = `${baseCents}:${installments}`;
    const cached = simulationCache.get(cacheKey);
    if (cached?.expiresAt > Date.now()) return cached.value;
    if (typeof asaasClient?.simulatePayment === "function") {
      try {
        const simulation = await asaasClient.simulatePayment({
          value: baseCents / 100,
          installmentCount: installments,
          billingTypes: ["CREDIT_CARD"],
        });
        const pricing = simulatedCardPricing(baseCents, installments, simulation);
        if (pricing) {
          simulationCache.set(cacheKey, { value: pricing, expiresAt: Date.now() + 15 * 60_000 });
          return pricing;
        }
      } catch (error) {
        console.error("Asaas sales simulation unavailable; using account fee fallback", { status: error?.status, code: error?.code });
      }
    }
    const fallback = { ...cardPricing(baseCents, installments, await accountFees()), source: "asaas_account_fees" };
    simulationCache.set(cacheKey, { value: fallback, expiresAt: Date.now() + 5 * 60_000 });
    return fallback;
  }
  router.get("/status", (_request, response) => response.json({ enabled: environment.checkoutEnabled && environment.galaticSalesEnabled,
    salesEnabled: environment.galaticSalesEnabled, reason: !environment.galaticSalesEnabled ? "store_not_open" : !environment.checkoutEnabled ? "payment_unavailable" : null,
    message: !environment.galaticSalesEnabled ? "A Galatic está preparando sua nova operação. Vendas em breve." : null, provider: "asaas", environment: environment.asaasEnvironment,
    methods: environment.checkoutEnabled && environment.galaticSalesEnabled ? ["pix", "credit_card"] : [], cardMode: "embedded_api", cardInstallmentMaximum: 10,
    cardInterest: "asaas_fees_passed_to_customer_from_2x", cardInterestFreeInstallments: 1, pixInstallment: false,
    maximumItemQuantity: MAX_ITEM_QUANTITY }));

  router.post("/installments", readLimiter,
    allowBodyFields(["items", "shipping", "couponCode", "buyerEmail"]), async (request, response) => {
    if (!environment.checkoutEnabled || !asaasClient || !store.previewCheckout) {
      return response.status(503).json({ error: "checkout_unavailable", message: "Condições de pagamento temporariamente indisponíveis." });
    }
    try {
      const cart = items(request.body?.items);
      exactObject(request.body?.shipping, ["quoteId"], "Frete");
      const quoteId = String(request.body?.shipping?.quoteId ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new GalaticInputError("Frete ausente ou expirado.", "invalid_shipping_quote");
      const couponCode = String(request.body?.couponCode ?? "").trim().toUpperCase() || null;
      if (couponCode && !/^[A-Z0-9_-]{3,40}$/.test(couponCode)) throw new GalaticInputError("Cupom inválido.", "invalid_coupon");
      const buyerEmail = String(request.body?.buyerEmail ?? "").trim().toLowerCase();
      if (couponCode && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) throw new GalaticInputError("Informe o e-mail para validar o cupom.", "invalid_email");
      const preview = await store.previewCheckout({ items: cart, quoteId, buyerEmail, couponCode });
      const plans = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
        const installments = index + 1;
        const pricing = await providerCardPricing(preview.totalCents, installments);
        return { installments, installmentCents: pricing.installmentCents, totalCents: pricing.totalCents,
          feeCents: pricing.feeCents, percentage: pricing.percentage, source: pricing.source };
      }));
      return response.json({ currency: "brl", pix: { totalCents: preview.totalCents }, card: plans, ...preview });
    } catch (error) {
      if (["product_unavailable", "insufficient_stock", "invalid_shipping_quote", "shipping_quote_mismatch"].includes(error?.code)) {
        return response.status(409).json({ error: error.code, message: "Preço, estoque ou frete mudou. Recalcule o carrinho." });
      }
      if (["invalid_coupon", "invalid_email"].includes(error?.code)) {
        return response.status(400).json({ error: error.code, message: error.message === "invalid_coupon" ? "Cupom inválido, expirado ou indisponível para esta compra." : error.message });
      }
      if (error instanceof GalaticInputError) {
        return response.status(400).json({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  router.post("/orders", writeLimiter, botChallenge.verify,
    allowBodyFields(["items", "buyer", "shipping", "payment", "couponCode", "website"]), async (request, response) => {
    if (!environment.galaticSalesEnabled) return response.status(503).json({ error: "store_not_open", message: "A Galatic está preparando sua nova operação. Vendas em breve." });
    if (request.body?.website) return response.status(400).json({ error: "invalid_checkout", message: "Não foi possível validar a solicitação." });
    if (!environment.checkoutEnabled || !asaasClient) return response.status(503).json({ error: "checkout_unavailable", message: "Pagamento temporariamente indisponível." });
    let key; let cart; let customer; let quoteId; let selectedPayment;
    try {
      key = uuid(request); cart = items(request.body?.items); customer = buyer(request.body?.buyer);
      exactObject(request.body?.shipping, ["quoteId"], "Frete");
      quoteId = String(request.body?.shipping?.quoteId ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new GalaticInputError("Frete ausente ou expirado.", "invalid_shipping_quote");
      selectedPayment = payment(request.body?.payment);
    } catch (error) {
      if (error instanceof GalaticInputError || error instanceof CreditCardInputError || error?.code === "shipping_destination_mismatch") return response.status(400).json({ error: error.code, message: error.message });
      throw error;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(request.body)).digest("hex");
    let prepared;
    const couponCode = String(request.body?.couponCode ?? "").trim().toUpperCase() || null;
    if (couponCode && !/^[A-Z0-9_-]{3,40}$/.test(couponCode)) return response.status(400).json({ error: "invalid_coupon", message: "Cupom inválido." });
    try { prepared = await store.prepareOrder({ key, fingerprint, items: cart, quoteId, buyer: customer,
      paymentMethod: selectedPayment.method, installments: selectedPayment.installments, couponCode }); }
    catch (error) {
      if (["product_unavailable", "insufficient_stock", "invalid_shipping_quote", "shipping_quote_mismatch"].includes(error?.code)) {
        return response.status(409).json({ error: error.code, message: "Preço, estoque ou frete mudou. Recalcule o carrinho." });
      }
      if (error?.code === "invalid_coupon") return response.status(400).json({ error: "invalid_coupon", message: "Cupom inválido, expirado ou indisponível para esta compra." });
      throw error;
    }
    if (prepared.kind === "conflict") return response.status(409).json({ error: "idempotency_conflict" });
    if (prepared.kind === "pending") {
      try {
        const recovered = recoverPayment ? await recoverPayment({ key }) : null;
        if (recovered) return response.status(recovered.status).json(recovered.body);
      } catch (error) { console.error("Galatic payment reconciliation pending", { code: error?.code }); }
      return response.status(202).json({ error: "payment_reconciliation_pending", orderId: prepared.orderId ?? null,
        message: "Estamos confirmando esta tentativa. Nao inicie outro pagamento." });
    }
    if (prepared.kind === "replay") return response.status(prepared.response.status).json(prepared.response.body);
    const order = { ...prepared.order, method: selectedPayment.method, installments: selectedPayment.installments };
    let operationClaimAttempted = false; let creationResponseReceived = false; let creationRejected = false;
    try {
      const providerCustomerId = await customerId(asaasClient, customer);
      if (!providerCustomerId) throw new Error("asaas_customer_missing");
      const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      let pricing = { baseCents: order.totalCents, totalCents: order.totalCents, feeCents: 0, percentage: 0,
        installmentCents: order.totalCents };
      const payload = { customer: providerCustomerId, billingType: selectedPayment.method === "pix" ? "PIX" : "CREDIT_CARD",
        dueDate, description: `Pedido Galatic ${order.id}`, externalReference: `galatic:${order.id}` };
      if (selectedPayment.method === "credit_card") {
        pricing = await providerCardPricing(order.totalCents, selectedPayment.installments);
        payload.creditCard = selectedPayment.card;
        payload.creditCardHolderInfo = cardHolderInfo({ ...customer, cpfCnpj: customer.document, mobilePhone: customer.phone, ip: request.ip });
        payload.remoteIp = request.ip;
      }
      if (selectedPayment.installments > 1) {
        payload.installmentCount = selectedPayment.installments;
        payload.totalValue = pricing.totalCents / 100;
      } else payload.value = pricing.totalCents / 100;
      operationClaimAttempted = true;
      await store.beginPaymentCreation(key, order.id, { pricing, customerId: providerCustomerId });
      let providerPayment;
      try { providerPayment = await asaasClient.createPayment(payload); creationResponseReceived = true; }
      catch (error) { creationRejected = [400, 422].includes(error?.status); throw error; }
      if (!matchesGalaticPayment(providerPayment, { order, pricing, providerCustomerId }, { installment: order.installments > 1 })) {
        throw Object.assign(new Error("asaas_payment_response_mismatch"), { code: "asaas_payment_response_mismatch" });
      }
      const status = normalizeAsaasPaymentStatus(providerPayment?.status);
      await store.attachPayment(order.id, providerPayment.id, status, { method: selectedPayment.method,
        installments: selectedPayment.installments, installmentAmountCents: pricing.installmentCents,
        paymentFeeCents: pricing.feeCents, totalCents: pricing.totalCents, providerGroupId: providerPayment?.installment ?? null });
      if (selectedPayment.method === "pix") try { await asaasClient.updatePayment(providerPayment.id, { billingType: "PIX", value: pricing.totalCents / 100,
        dueDate: providerPayment.dueDate, description: `Pedido Galatic ${order.id}`, externalReference: `galatic:${order.id}` }); } catch (error) { console.error("Could not update Galatic Pix", { code: error?.code, status: error?.status }); }
      let instructions = null;
      if (selectedPayment.method === "pix") try { instructions = pix(await asaasClient.getPixQrCode(providerPayment.id)); } catch (error) { console.error("Galatic Pix is being prepared", { code: error?.code, status: error?.status }); }
      const current = await store.getOrderByPublicId(order.id);
      const result = galaticPaymentResponse(order, pricing, current?.status ?? status, instructions);
      await store.completeCheckoutAttempt(key, result);
      if (!store.enqueueNotification) notifications?.sendOrderCreated?.({ email: customer.email, name: customer.name, orderId: order.id,
        totalCents: pricing.totalCents, method: selectedPayment.method }).catch((error) => {
        console.error("Could not send Galatic order email", { type: error?.name, code: error?.code });
      });
      return response.status(201).json(result.body);
    } catch (error) {
      console.error("Galatic Asaas checkout failed", { code: error?.code, status: error?.status, type: error?.name });
      const definitiveFailure = !operationClaimAttempted || (creationRejected && !creationResponseReceived);
      if (definitiveFailure) {
        const cardRejected = selectedPayment.method === "credit_card" && creationRejected;
        const result = { status: cardRejected ? 400 : 502, body: { error: cardRejected ? "credit_card_refused" : "checkout_provider_error",
          message: cardRejected ? "Pagamento nao autorizado. Revise os dados ou use outro cartao." : "Nao foi possivel preparar o pagamento. Recalcule o carrinho." } };
        try { await store.releaseFailedOrder(order.id, key, result); }
        catch { return response.status(202).json({ error: "payment_reconciliation_pending", orderId: order.id }); }
        return response.status(result.status).json(result.body);
      }
      await store.markPaymentCreationUncertain?.(key, error?.code ?? error?.name).catch(() => {});
      return response.status(202).json({ error: "payment_reconciliation_pending", orderId: order.id,
        message: "Estamos confirmando esta tentativa. Nao inicie outro pagamento." });
    }
  });

  // The random key is a bearer capability, like the public order UUID.
  // The response contains no buyer, address or card data.
  router.get("/attempts/:key", readLimiter, async (request, response) => {
    const key = String(request.params.key ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(key) || !store.getCheckoutAttemptResult) return response.status(404).json({ error: "attempt_not_found" });
    const attempt = await store.getCheckoutAttemptResult(key);
    if (!attempt) return response.status(404).json({ error: "attempt_not_found" });
    if (attempt.response) return response.status(200).json(attempt.response.body);
    try {
      const recovered = recoverPayment ? await recoverPayment({ key }) : null;
      if (recovered) return response.status(200).json(recovered.body);
    } catch (error) { console.error("Galatic checkout recovery pending", { code: error?.code }); }
    return response.status(202).json({ error: "payment_reconciliation_pending", orderId: attempt.orderId,
      message: "Estamos confirmando esta tentativa. Nao inicie outro pagamento." });
  });

  router.get("/orders/:orderId", readLimiter, async (request, response) => {
    const id = String(request.params.orderId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return response.status(404).json({ error: "order_not_found" });
    const order = await store.getOrderByPublicId(id);
    if (!order) return response.status(404).json({ error: "order_not_found" });
    if (order.providerOrderId && asaasClient) {
      try { const payment = await asaasClient.getPayment(order.providerOrderId); const status = normalizeAsaasPaymentStatus(payment?.status); if (status !== order.status) await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: order.providerOrderId, status }); order.status = status; } catch {}
    }
    response.set("Cache-Control", "no-store").json(order);
  });
  router.get("/orders/:orderId/pix", readLimiter, async (request, response) => {
    const id = String(request.params.orderId ?? ""); const order = /^[0-9a-f-]{36}$/i.test(id) ? await store.getOrderByPublicId(id) : null;
    if (!order?.providerOrderId || order.method !== "pix" || !asaasClient) return response.status(404).json({ error: "order_not_found" });
    try { const payment = await asaasClient.getPayment(order.providerOrderId); const status = normalizeAsaasPaymentStatus(payment?.status); if (status === "paid") return response.json({ id, status }); const instructions = pix(await asaasClient.getPixQrCode(order.providerOrderId)); return instructions ? response.json({ id, status, pix: instructions }) : response.status(202).json({ id, status, pixPending: true }); }
    catch { return response.status(502).json({ error: "pix_retrieval_failed" }); }
  });
  return router;
}
