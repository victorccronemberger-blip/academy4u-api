import { closedGalaticFinancialGate, financialRoute } from "../services/galatic-financial-gate.js";
import { galaticPostcode } from "../domain/galatic-address.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import { allowBodyFields } from "../http/request-security.js";

class ShippingInputError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
const digits = (value) => String(value ?? "").replace(/\D/g, "");
const clean = (value, max = 160) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
function cartItems(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new ShippingInputError("Carrinho inválido.");
  const quantities = new Map();
  for (const row of input) {
    const key = String(row?.sku ?? row?.slug ?? "").trim(); const quantity = Number(row?.quantity);
    if (!/^[A-Za-z0-9_-]{2,100}$/.test(key) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) throw new ShippingInputError("Item inválido no carrinho.");
    quantities.set(key, (quantities.get(key) ?? 0) + quantity);
  }
  return [...quantities].map(([key, quantity]) => ({ key, quantity }));
}
async function viaCep(postalCode) {
  const response = await fetch(`https://viacep.com.br/ws/${postalCode}/json/`, { signal: AbortSignal.timeout(7_000) });
  const address = await response.json().catch(() => null);
  if (!response.ok || !address || address.erro) throw new ShippingInputError("CEP não encontrado.");
  return { postalCode, street: clean(address.logradouro) || "Endereço informado no checkout", district: clean(address.bairro) || "Centro", city: clean(address.localidade), state: clean(address.uf, 2).toUpperCase() };
}
function destination(input, fallback, origin) {
  if (!input || typeof input !== "object") return fallback;
  const postalCode = galaticPostcode(input) || fallback.postalCode;
  return { postalCode, street: clean(input.street ?? input.logradouro) || fallback.street,
    number: clean(input.number ?? input.numero, 20) || "S/N", complement: clean(input.complement ?? input.complemento),
    district: clean(input.district ?? input.bairro) || fallback.district, city: clean(input.city ?? input.cidade) || fallback.city,
    state: clean(input.state ?? input.uf, 2).toUpperCase() || fallback.state, name: clean(input.recipient_name ?? input.name) || "Cliente Galatic",
    phone: digits(input.phone) || origin.phone, document: digits(input.federal_tax_id ?? input.document) || origin.taxId,
    email: clean(input.email) || origin.email };
}
export function enviaAddress(origin) {
  return { name: origin.name, company: origin.name, email: origin.email, phone: origin.phone,
    street: origin.street, number: origin.number, district: origin.district, city: origin.city, state: origin.state, country: "BR",
    postalCode: origin.postalCode, identificationNumber: origin.taxId };
}

export function destinationAddress(to) {
  return { name: to.name, email: to.email, phone: to.phone, street: to.street, number: to.number || "S/N", district: to.district,
    city: to.city, state: to.state, country: "BR", postalCode: to.postalCode, identificationNumber: to.document };
}

export function createGalaticShippingRouter(express, { environment, store, enviaClient,
  financialGate = closedGalaticFinancialGate,
  botChallenge = { verify: (_request, _response, next) => next() } }) {
  const router = express.Router(); const limiter = createFixedWindowLimiter({ windowMs: 60_000, limit: 20,
    prefix: "galatic-shipping", consume: store.consumeRateLimit?.bind(store) });
  router.get("/status", (_request, response) => response.json({ enabled: Boolean(financialGate.enabled && enviaClient?.ready && environment.galaticShippingOrigin),
    financialOperationsEnabled: financialGate.enabled, reason: financialGate.enabled ? null : "financial_operations_paused",
    provider: "envia", environment: environment.galaticEnviaEnvironment, labels: financialGate.enabled, tracking: financialGate.enabled }));
  financialRoute(router, financialGate, "post", "/", limiter, botChallenge.verify, allowBodyFields(["items", "postalCode", "destination"]), async (request, response) => {
    if (!financialGate.enabled) return financialGate.paused(response);
    if (!enviaClient?.ready || !environment.galaticShippingOrigin) return response.status(503).json({ error: "shipping_unavailable", message: "Cotação temporariamente indisponível." });
    try {
      const requested = cartItems(request.body?.items); const postalCode = galaticPostcode({ postCode: request.body?.postalCode, postalCode: galaticPostcode(request.body?.destination) });
      if (postalCode.length !== 8) throw new ShippingInputError("Informe um CEP válido.");
      const products = await store.getProductsForCheckout(requested); const byKey = new Map();
      for (const product of products) { byKey.set(product.sku, product); byKey.set(product.slug, product); }
      const normalized = requested.map((item) => ({ product: byKey.get(item.key), quantity: item.quantity }));
      if (normalized.some((item) => !item.product?.active)) throw new ShippingInputError("Um produto está indisponível.", 409);
      for (const item of normalized) {
        if (item.product.manageStock && (!Number.isInteger(item.product.stockQuantity) || item.product.stockQuantity < item.quantity)) throw new ShippingInputError(`Estoque insuficiente para ${item.product.title}.`, 409);
        if (!item.product.weightGrams || !item.product.lengthCm || !item.product.widthCm || !item.product.heightCm) throw new ShippingInputError(`Frete indisponível para ${item.product.title}: peso ou dimensões ainda não cadastrados.`, 409);
      }
      const base = await viaCep(postalCode); const to = destination(request.body?.destination, base, environment.galaticShippingOrigin);
      const packages = normalized.map((item) => ({ type: "box", content: item.product.title.slice(0, 80), amount: item.quantity,
        declaredValue: item.product.unitAmountCents / 100, weight: item.product.weightGrams / 1000, weightUnit: "KG", lengthUnit: "CM",
        dimensions: { length: item.product.lengthCm, width: item.product.widthCm, height: item.product.heightCm } }));
      const quotePayload = { origin: enviaAddress(environment.galaticShippingOrigin), destination: destinationAddress(to), packages,
        shipment: { type: 1, carrier: "correios" }, settings: { currency: "BRL" } };
      const providerResult = await enviaClient.quote(quotePayload);
      const rates = (Array.isArray(providerResult?.data) ? providerResult.data : []).map((rate) => {
        const carrierCode = clean(rate.carrier ?? rate.carrierCode ?? "correios", 30).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const service = clean(rate.service ?? rate.serviceCode ?? rate.serviceDescription ?? "entrega", 40).toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
        return {
        carrier: clean(rate.carrierDescription ?? rate.carrier ?? "Correios", 60), serviceName: clean(rate.serviceDescription ?? rate.service ?? "Entrega", 100),
        serviceCode: `${carrierCode}:${service}`,
        amountCents: Math.round(Number(rate.totalPrice) * 100), deliveryDays: Math.max(0, Number(rate.deliveryDate?.dateDifference ?? 0)),
      }; }).filter((rate) => rate.amountCents > 0).sort((a, b) => a.deliveryDays - b.deliveryDays || a.amountCents - b.amountCents).slice(0, 3);
      if (!rates.length) return response.status(503).json({ error: "shipping_unavailable", message: "Nenhuma entrega disponível para este CEP." });
      financialGate.assertEnabled();
      const saved = await store.createShippingQuotes({ destinationPostcode: to.postalCode, items: normalized.map((item) => ({ sku: item.product.sku, quantity: item.quantity, logistics: { weight_grams: item.product.weightGrams, length_cm: item.product.lengthCm, width_cm: item.product.widthCm, height_cm: item.product.heightCm } })), quotes: rates });
      response.json({ quotes: saved.map((quote) => ({ quote_id: quote.id, carrier: quote.carrier, service: quote.serviceName, amount: quote.amountCents, currency: "brl", estimated_days: quote.deliveryDays })), address: base, provider: "envia", expires_in: 900 });
    } catch (error) {
      if (error?.code === "shipping_destination_mismatch") return response.status(422).json({ error: error.code, message: "O destino informado diverge do CEP da cotação." });
      if (error instanceof ShippingInputError) return response.status(error.status).json({ error: error.message });
      console.error("Galatic shipping quote failed", { status: error?.status, type: error?.name });
      response.status(502).json({ error: "Não foi possível calcular o frete agora." });
    }
  });
  return router;
}
