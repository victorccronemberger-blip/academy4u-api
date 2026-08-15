import { createHash } from "node:crypto";
import { normalizeBrazilianTaxId } from "../domain/brazilian-tax-id.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";
import { CreditCardInputError, cardHolderInfo, parseCreditCard } from "../domain/credit-card.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

class GalaticInputError extends Error {
  constructor(message, code = "invalid_checkout") { super(message); this.code = code; }
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
    const key = String(item?.sku ?? item?.slug ?? "").trim();
    const quantity = Number(item?.quantity);
    if (!/^[A-Za-z0-9_-]{2,100}$/.test(key) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new GalaticInputError("Item inválido no carrinho.");
    }
    quantities.set(key, (quantities.get(key) ?? 0) + quantity);
  }
  return [...quantities].map(([key, quantity]) => ({ key, quantity }));
}
function buyer(input) {
  const firstName = text(input?.firstName, 2, 80, "Nome");
  const lastName = text(input?.lastName, 2, 100, "Sobrenome");
  const email = String(input?.email ?? "").trim().toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GalaticInputError("E-mail inválido.");
  const address = input?.address;
  if (!address || typeof address !== "object") throw new GalaticInputError("Endereço inválido.");
  const state = text(address.state ?? address.uf, 2, 2, "UF").toUpperCase();
  const normalizedAddress = {
    postCode: digits(address.postCode ?? address.postalCode ?? address.postal_code ?? address.cep, 8, 8, "CEP"),
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

export function createGalaticCheckoutRouter(express, { environment, asaasClient, store, notifications = null }) {
  const router = express.Router();
  const writeLimiter = createFixedWindowLimiter({ windowMs: 60_000, limit: 12, prefix: "galatic-checkout" });
  const readLimiter = createFixedWindowLimiter({ windowMs: 60_000, limit: 60, prefix: "galatic-order" });
  let feeCache = null;
  async function accountFees() {
    if (feeCache?.expiresAt > Date.now()) return feeCache.value;
    const value = await asaasClient.getAccountFees();
    feeCache = { value, expiresAt: Date.now() + 15 * 60_000 };
    return value;
  }
  router.get("/status", (_request, response) => response.json({ enabled: environment.checkoutEnabled, provider: "asaas", environment: environment.asaasEnvironment,
    methods: environment.checkoutEnabled ? ["pix", "credit_card"] : [], cardMode: "embedded_api", cardInstallmentMaximum: 10,
    cardInterest: "asaas_fees_passed_to_customer", pixInstallment: false }));

  router.post("/orders", writeLimiter, async (request, response) => {
    if (!environment.checkoutEnabled || !asaasClient) return response.status(503).json({ error: "checkout_unavailable", message: "Pagamento temporariamente indisponível." });
    let key; let cart; let customer; let quoteId; let selectedPayment;
    try {
      key = uuid(request); cart = items(request.body?.items); customer = buyer(request.body?.buyer);
      quoteId = String(request.body?.shipping?.quoteId ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new GalaticInputError("Frete ausente ou expirado.", "invalid_shipping_quote");
      selectedPayment = payment(request.body?.payment);
    } catch (error) {
      if (error instanceof GalaticInputError || error instanceof CreditCardInputError) return response.status(400).json({ error: error.code, message: error.message });
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
    if (prepared.kind === "pending") return response.status(409).json({ error: "idempotency_in_progress" });
    if (prepared.kind === "replay") return response.status(prepared.response.status).json(prepared.response.body);
    const order = prepared.order;
    try {
      const providerCustomerId = await customerId(asaasClient, customer);
      if (!providerCustomerId) throw new Error("asaas_customer_missing");
      const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      let pricing = { baseCents: order.totalCents, totalCents: order.totalCents, feeCents: 0, percentage: 0,
        installmentCents: order.totalCents };
      const payload = { customer: providerCustomerId, billingType: selectedPayment.method === "pix" ? "PIX" : "CREDIT_CARD",
        dueDate, description: `Pedido Galatic ${order.id}`, externalReference: `galatic:${order.id}` };
      if (selectedPayment.method === "credit_card") {
        pricing = cardPricing(order.totalCents, selectedPayment.installments, await accountFees());
        payload.creditCard = selectedPayment.card;
        payload.creditCardHolderInfo = cardHolderInfo({ ...customer, cpfCnpj: customer.document, mobilePhone: customer.phone, ip: request.ip });
        payload.remoteIp = request.ip;
      }
      if (selectedPayment.installments > 1) {
        payload.installmentCount = selectedPayment.installments;
        payload.totalValue = pricing.totalCents / 100;
      } else payload.value = pricing.totalCents / 100;
      const providerPayment = await asaasClient.createPayment(payload);
      const status = normalizeAsaasPaymentStatus(providerPayment?.status);
      await store.attachPayment(order.id, providerPayment.id, status, { method: selectedPayment.method,
        installments: selectedPayment.installments, installmentAmountCents: pricing.installmentCents,
        paymentFeeCents: pricing.feeCents, totalCents: pricing.totalCents, providerGroupId: providerPayment?.installment ?? null });
      if (selectedPayment.method === "pix") try { await asaasClient.updatePayment(providerPayment.id, { billingType: "PIX", value: pricing.totalCents / 100,
        dueDate: providerPayment.dueDate, description: `Pedido Galatic ${order.id}`, externalReference: `galatic:${order.id}` }); } catch (error) { console.error("Could not update Galatic Pix", { code: error?.code, status: error?.status }); }
      let instructions = null;
      if (selectedPayment.method === "pix") try { instructions = pix(await asaasClient.getPixQrCode(providerPayment.id)); } catch (error) { console.error("Galatic Pix is being prepared", { code: error?.code, status: error?.status }); }
      const result = { status: 201, body: { orderId: order.id, status, method: selectedPayment.method,
        installments: selectedPayment.installments, installmentCents: pricing.installmentCents, cardFeeCents: pricing.feeCents,
        subtotalCents: order.subtotalCents, shippingCents: order.shippingCents, discountCents: order.discountCents ?? 0,
        couponCode: order.couponCode ?? null, baseTotalCents: order.totalCents,
        totalCents: pricing.totalCents, ...(selectedPayment.method === "pix" ? (instructions ? { pix: instructions } : { pixPending: true })
          : { message: status === "paid" ? "Pagamento aprovado." : "Pagamento recebido e em análise." }) } };
      await store.completeCheckoutAttempt(key, result);
      notifications?.sendOrderCreated?.({ email: customer.email, name: customer.name, orderId: order.id,
        totalCents: pricing.totalCents, method: selectedPayment.method }).catch((error) => {
        console.error("Could not send Galatic order email", { type: error?.name, code: error?.code });
      });
      return response.status(201).json(result.body);
    } catch (error) {
      await store.releaseFailedOrder(order.id, key);
      console.error("Galatic Asaas checkout failed", { code: error?.code, status: error?.status, type: error?.name });
      const cardRejected = selectedPayment?.method === "credit_card" && error?.status === 400;
      return response.status(cardRejected ? 400 : 502).json({ error: cardRejected ? "credit_card_refused" : "checkout_provider_error",
        message: cardRejected ? "Pagamento não autorizado. Revise os dados ou use outro cartão." : "A Asaas não pôde criar o pagamento. Tente novamente." });
    }
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
