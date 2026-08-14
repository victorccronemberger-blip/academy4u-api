import { createHash, timingSafeEqual } from "node:crypto";
import {
  MAX_INTEREST_FREE_INSTALLMENTS,
  MAX_PIX_INSTALLMENTS,
  MIN_CARD_INSTALLMENT_CENTS,
  MIN_PIX_INSTALLMENT_CENTS,
  createInterestFreeInstallments,
  interestFreeInstallment,
} from "../domain/installments.js";
import { CheckoutValidationError, createAuthoritativeQuote } from "../domain/quote.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";
import { providerId } from "../domain/provider-values.js";
import { CreditCardInputError, cardHolderInfo, parseCreditCard } from "../domain/credit-card.js";

class CheckoutInputError extends Error {
  constructor(message, code = "invalid_checkout") {
    super(message);
    this.name = "CheckoutInputError";
    this.code = code;
  }
}

// Comparação em tempo constante do token de checkout confiado (chamada
// servidor-a-servidor do frontend LMS; cabeçalho x-academy-trusted-token).
function safeEqual(received, expected) {
  const left = Buffer.from(String(received ?? ""), "utf8");
  const right = Buffer.from(String(expected ?? ""), "utf8");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function cleanDigits(value, min, max, label) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < min || digits.length > max) {
    throw new CheckoutInputError(`${label} inválido.`);
  }
  return digits;
}

function hasRepeatedDigits(value) {
  return /^(\d)\1+$/.test(value);
}

function isValidCpf(value) {
  if (value.length !== 11 || hasRepeatedDigits(value)) return false;
  const calculateDigit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(value[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return calculateDigit(9) === Number(value[9])
    && calculateDigit(10) === Number(value[10]);
}

function isValidCnpj(value) {
  if (value.length !== 14 || hasRepeatedDigits(value)) return false;
  const calculateDigit = (length) => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculateDigit(12) === Number(value[12])
    && calculateDigit(13) === Number(value[13]);
}

function cleanDocument(value) {
  const document = cleanDigits(value, 11, 14, "CPF ou CNPJ");
  if (!isValidCpf(document) && !isValidCnpj(document)) {
    throw new CheckoutInputError("CPF ou CNPJ inválido.", "invalid_document");
  }
  return document;
}

function cleanText(value, min, max, label) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length < min || text.length > max) {
    throw new CheckoutInputError(`${label} inválido.`);
  }
  return text;
}

const BRAZILIAN_STATES = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

function cleanBirthDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const date = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new CheckoutInputError("Data de nascimento inválida.", "invalid_birth_date");
  }
  const year = Number(date.slice(0, 4));
  const nowYear = new Date().getUTCFullYear();
  if (year < 1900 || year > nowYear - 10) {
    throw new CheckoutInputError("Data de nascimento inválida.", "invalid_birth_date");
  }
  return date;
}

// Endereço completo do comprador. Opcional na API, mas validado quando presente.
function cleanAddress(input) {
  if (!input || typeof input !== "object") return null;
  const digits = (value, max) => String(value ?? "").replace(/\D/g, "").slice(0, max) || null;
  const text = (value, max) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max) || null;
  const state = text(input.state ?? input.uf, 2)?.toUpperCase() ?? null;
  if (state && !BRAZILIAN_STATES.has(state)) throw new CheckoutInputError("UF inválida.", "invalid_address");
  const postCode = digits(input.postCode ?? input.cep, 8);
  if (postCode && postCode.length !== 8) throw new CheckoutInputError("CEP inválido.", "invalid_address");
  const address = {
    postCode,
    street: text(input.street ?? input.rua, 160),
    number: text(input.number ?? input.numero, 16),
    complement: text(input.complement ?? input.complemento, 160),
    district: text(input.district ?? input.bairro, 120),
    city: text(input.city ?? input.cidade, 120),
    state,
  };
  return Object.values(address).some(Boolean) ? address : null;
}

function parseBuyer(input, requestIp) {
  if (!input || typeof input !== "object") throw new CheckoutInputError("Dados do comprador inválidos.");
  const email = String(input.email ?? "").trim().toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CheckoutInputError("E-mail inválido.");
  }
  const ip = String(requestIp ?? "").replace(/^::ffff:/, "").trim();
  if (ip.length < 3 || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip)) {
    throw new CheckoutInputError("Não foi possível validar a conexão do comprador.", "invalid_customer_ip");
  }
  return {
    name: `${cleanText(input.firstName, 2, 80, "Nome")} ${cleanText(input.lastName, 2, 100, "Sobrenome")}`,
    email,
    mobilePhone: cleanDigits(input.phone, 10, 13, "Telefone"),
    cpfCnpj: cleanDocument(input.documentNumber),
    birthDate: cleanBirthDate(input.birthDate ?? input.birth_date),
    address: cleanAddress(input.address),
    ip,
  };
}

function validateMinimumCharge(totalCents, payment) {
  const pixMethod = payment.method === "pix" || payment.method === "pix_installment";
  const minimumInstallmentCents = pixMethod
    ? MIN_PIX_INSTALLMENT_CENTS
    : MIN_CARD_INSTALLMENT_CENTS;
  const minimumTotalCents = minimumInstallmentCents * payment.installments;
  if (totalCents >= minimumTotalCents) return;

  if (payment.method === "pix") {
    throw new CheckoutInputError(
      "O valor mínimo para pagamento por Pix é R$ 10,00. Ajuste o cupom ou adicione outro curso.",
      "payment_amount_below_minimum",
    );
  }
  const methodLabel = payment.method === "pix_installment" ? "Pix" : "cartão";
  const minimum = (minimumInstallmentCents / 100).toFixed(2).replace(".", ",");
  throw new CheckoutInputError(
    `Cada parcela no ${methodLabel} precisa ter no mínimo R$ ${minimum}. Escolha menos parcelas ou ajuste o cupom.`,
    "payment_amount_below_minimum",
  );
}

function parsePayment(input) {
  if (!input || typeof input !== "object") throw new CheckoutInputError("Meio de pagamento inválido.");
  if (input.method === "pix") return { method: "pix", installments: 1 };
  if (!["pix_installment", "credit_card"].includes(input.method)) {
    throw new CheckoutInputError("Meio de pagamento inválido.");
  }
  const installments = Number(input.installments);
  const maximum = input.method === "pix_installment"
    ? MAX_PIX_INSTALLMENTS
    : MAX_INTEREST_FREE_INSTALLMENTS;
  if (
    !Number.isSafeInteger(installments)
    || installments < (input.method === "pix_installment" ? 2 : 1)
    || installments > maximum
  ) {
    throw new CheckoutInputError("Número de parcelas inválido.", "invalid_installments");
  }
  return { method: input.method, installments };
}

async function quoteFromBody(body, store, checkoutIdentity = null, productResolver = undefined) {
  if (Array.isArray(body?.courseIds)) {
    if (!checkoutIdentity?.userId || typeof store?.createLmsCheckoutQuote !== "function") {
      throw new CheckoutInputError("SessÃ£o de pagamento invÃ¡lida.", "invalid_checkout_session");
    }
    try {
      return await store.createLmsCheckoutQuote({
        userId: checkoutIdentity.userId,
        recipientUserId: body?.recipientUserId ?? checkoutIdentity.userId,
        courseIds: body.courseIds,
        couponCode: body?.couponCode,
      });
    } catch (error) {
      const messages = {
        invalid_lms_cart: "O carrinho mudou ou contÃ©m um curso indisponÃ­vel.",
        invalid_lms_recipient: "O destinatÃ¡rio do curso nÃ£o estÃ¡ disponÃ­vel.",
        already_enrolled: "O aluno jÃ¡ possui um dos cursos selecionados.",
        invalid_coupon: "Cupom invÃ¡lido ou expirado.",
      };
      const code = String(error?.message ?? "");
      if (messages[code]) throw new CheckoutInputError(messages[code], code);
      throw error;
    }
  }
  const slugs = body?.slugs;
  const couponCode = body?.couponCode;
  const normalized = typeof couponCode === "string" ? couponCode.trim().toUpperCase().replace(/\s+/g, "") : null;
  const coupon = normalized && Array.isArray(slugs)
    ? await store?.getEligibleCoupon(normalized, [...new Set(slugs)])
    : null;
  return createAuthoritativeQuote({ slugs, couponCode }, { coupon, productResolver });
}

function checkoutFingerprint(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function idempotencyKey(request) {
  const value = request.get("Idempotency-Key")?.trim();
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CheckoutInputError("Identificador da tentativa inválido.", "invalid_idempotency_key");
  }
  return value;
}

function handleInputError(error, response) {
  if (error instanceof CheckoutValidationError || error instanceof CheckoutInputError || error instanceof CreditCardInputError) {
    response.status(400).json({ error: error.code, message: error.message, retryable: true });
    return true;
  }
  return false;
}

function amount(cents) {
  return Number((cents / 100).toFixed(2));
}

function dueDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function findOrCreateCustomer(asaasClient, buyer, key, referencePrefix = "academy") {
  const existing = await asaasClient.findCustomersByDocument(buyer.cpfCnpj);
  const match = Array.isArray(existing?.data) ? existing.data.find((customer) => customer?.id) : null;
  if (match) return providerId(match.id, "customer id");
  const created = await asaasClient.createCustomer({
    name: buyer.name,
    cpfCnpj: buyer.cpfCnpj,
    email: buyer.email,
    mobilePhone: buyer.mobilePhone,
    ...(buyer.address?.street ? {
      address: buyer.address.street,
      addressNumber: buyer.address.number ?? "S/N",
      complement: buyer.address.complement ?? undefined,
      province: buyer.address.district ?? undefined,
      postalCode: buyer.address.postCode ?? undefined,
    } : {}),
    externalReference: `${referencePrefix}-customer:${key}`,
  });
  return providerId(created?.id, "customer id");
}

function paymentPayload({ customerId, quote, payment, key, buyer, card, referencePrefix = "academy" }) {
  const pixMethod = payment.method === "pix" || payment.method === "pix_installment";
  const payload = {
    customer: customerId,
    billingType: pixMethod ? "PIX" : "CREDIT_CARD",
    dueDate: dueDate(),
    description: quote.lines.map((line) => line.product.title).join(" + ").slice(0, 500),
    externalReference: `${referencePrefix}:${key}`,
  };
  if (payment.method === "credit_card") {
    payload.creditCard = card;
    payload.creditCardHolderInfo = cardHolderInfo(buyer);
    payload.remoteIp = buyer.ip;
  }
  if (payment.installments > 1) {
    return {
      ...payload,
      installmentCount: payment.installments,
      totalValue: amount(quote.totalCents),
    };
  }
  return { ...payload, value: amount(quote.totalCents) };
}

function paymentCallbackPayload(providerPayment, successUrl) {
  const billingType = String(providerPayment?.billingType ?? "").trim().toUpperCase();
  const value = Number(providerPayment?.value);
  const paymentDueDate = String(providerPayment?.dueDate ?? "").trim();
  if (
    !["UNDEFINED", "BOLETO", "CREDIT_CARD", "PIX"].includes(billingType)
    || !Number.isFinite(value)
    || value <= 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDueDate)
  ) {
    throw new Error("Asaas returned incomplete payment data for callback configuration.");
  }

  const payload = {
    billingType,
    value,
    dueDate: paymentDueDate,
    callback: {
      successUrl,
      autoRedirect: true,
    },
  };
  const description = String(providerPayment?.description ?? "").trim();
  const externalReference = String(providerPayment?.externalReference ?? "").trim();
  if (description) payload.description = description;
  if (externalReference) payload.externalReference = externalReference;
  return payload;
}

function publicPixInstructions(pix) {
  if (typeof pix?.encodedImage !== "string" || typeof pix?.payload !== "string") return null;
  if (!pix.encodedImage.trim() || !pix.payload.trim()) return null;
  return {
    qrCodeBase64: pix.encodedImage,
    emv: pix.payload,
    expiresAt: pix.expirationDate ?? null,
  };
}

export function createCheckoutRouter(express, {
  environment,
  asaasClient,
  installmentService,
  store,
  productResolver,
  onAccessGranted = null,
}) {
  const router = express.Router();
  const writeLimiter = createFixedWindowLimiter({ limit: 12 });
  // O checkout consulta o estado a cada poucos segundos. Separar leituras de
  // criações impede que o polling legítimo bloqueie uma nova tentativa de
  // pagamento, sem afrouxar o limite das rotas que criam cobranças.
  const readLimiter = createFixedWindowLimiter({ limit: 120 });

  function requireProvider(response) {
    if (environment.checkoutEnabled && asaasClient) return true;
    response.status(503).json({
      error: "checkout_unavailable",
      message: "A conta de pagamentos ainda precisa ser conectada.",
    });
    return false;
  }

  // A criação de pedidos é exclusiva do frontend confiável (LMS), chamada
  // servidor-a-servidor. O token ausente ou divergente bloqueia a rota.
  async function authorizeCheckout(request, response) {
    const authorization = String(request.get("authorization") ?? "").trim();
    if (/^Bearer\s+/i.test(authorization) && typeof store?.authenticateCheckoutToken === "function") {
      const identity = await store.authenticateCheckoutToken(authorization.replace(/^Bearer\s+/i, ""));
      if (identity) return identity;
    }
    if (!environment.trustedCheckoutToken) {
      response.status(503).json({
        error: "checkout_unavailable",
        message: "O checkout entre servidores ainda não foi configurado.",
      });
      return null;
    }
    if (!safeEqual(request.get("x-academy-trusted-token"), environment.trustedCheckoutToken)) {
      response.status(401).json({
        error: "unauthenticated",
        message: "Token de checkout inválido.",
      });
      return null;
    }
    return { kind: "trusted", userId: null, tokenId: null };
  }

  router.get("/status", (_request, response) => {
    response.json({
      enabled: environment.checkoutEnabled,
      provider: "asaas",
      environment: environment.asaasEnvironment,
      methods: environment.checkoutEnabled ? ["pix", "pix_installment", "credit_card"] : [],
      cardMode: "embedded_api",
      cardInstallmentMaximum: MAX_INTEREST_FREE_INSTALLMENTS,
      pixInstallmentMode: "monthly_manual_payment",
      pixInstallmentMaximum: MAX_PIX_INSTALLMENTS,
      pixAutomatic: false,
      minimumPixInstallmentCents: MIN_PIX_INSTALLMENT_CENTS,
      minimumCardInstallmentCents: MIN_CARD_INSTALLMENT_CENTS,
    });
  });

  router.post("/installments", writeLimiter, async (request, response) => {
    if (!requireProvider(response)) return;
    let quote;
    try {
      const checkoutIdentity = Array.isArray(request.body?.courseIds)
        ? await authorizeCheckout(request, response)
        : null;
      if (Array.isArray(request.body?.courseIds) && !checkoutIdentity) return;
      quote = await quoteFromBody(request.body, store, checkoutIdentity, productResolver);
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }
    const cardInstallments = createInterestFreeInstallments(quote.totalCents);
    const pixInstallments = createInterestFreeInstallments(quote.totalCents, {
      maximum: MAX_PIX_INSTALLMENTS,
      minimumInstallmentCents: MIN_PIX_INSTALLMENT_CENTS,
    })
      .filter((option) => option.number >= 2)
      .map((option) => ({
        number: option.number,
        totalCents: option.totalCents,
        installmentCents: option.installmentCents,
        lastInstallmentCents: option.lastInstallmentCents,
        installmentAmountsCents: option.installmentAmountsCents,
      }));
    response.json({
      couponCode: quote.coupon?.code ?? quote.couponCode ?? null,
      subtotalCents: quote.subtotalCents,
      discountCents: quote.discountCents,
      totalCents: quote.totalCents,
      baseTotalCents: quote.totalCents,
      maximumInstallments: MAX_INTEREST_FREE_INSTALLMENTS,
      maximumPixInstallments: MAX_PIX_INSTALLMENTS,
      cardInterestFree: true,
      pixTotalPreserved: true,
      installments: cardInstallments,
      cardInstallments,
      pixInstallments,
    });
  });

  router.post("/orders", writeLimiter, async (request, response) => {
    if (!requireProvider(response)) return;
    const checkoutIdentity = await authorizeCheckout(request, response);
    if (!checkoutIdentity) return;

    let key;
    let quote;
    let buyer;
    let payment;
    try {
      key = idempotencyKey(request);
      quote = await quoteFromBody(request.body, store, checkoutIdentity, productResolver);
      buyer = parseBuyer(request.body?.buyer, request.ip);
      payment = parsePayment(request.body?.payment);
      if (payment.method === "credit_card") {
        payment.card = parseCreditCard(request.body?.payment?.card);
        if (!buyer.address?.postCode || !buyer.address?.number) {
          throw new CheckoutInputError("Informe o CEP e o nÃºmero do endereÃ§o de cobranÃ§a.", "invalid_card_address");
        }
      }
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }
    try {
      validateMinimumCharge(quote.totalCents, payment);
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }

    const fingerprint = checkoutFingerprint(request.body);
    const attempt = await store.beginCheckoutAttempt(key, fingerprint);
    if (attempt.kind === "conflict") {
      response.status(409).json({ error: "idempotency_conflict", message: "Esta tentativa já foi usada com outro pedido.", retryable: true });
      return;
    }
    if (attempt.kind === "replay") {
      response.status(attempt.response.status).json(attempt.response.body);
      return;
    }
    if (attempt.kind === "pending") {
      response.status(409).json({ error: "idempotency_in_progress", message: "Esta tentativa ainda está sendo processada." });
      return;
    }

    if (quote.coupon && !quote.lms) {
      const reserved = await store.reserveCoupon(
        quote.coupon.code,
        key,
        quote.lines.map((line) => line.product.slug),
      );
      if (!reserved) {
        const result = { status: 400, body: { error: "invalid_coupon", message: "Cupom inválido ou indisponível.", retryable: true } };
        await store.abandonCheckoutAttempt(key);
        response.status(result.status).json(result.body);
        return;
      }
      quote = createAuthoritativeQuote(
        { slugs: request.body?.slugs, couponCode: quote.coupon.code },
        { coupon: reserved, productResolver },
      );
    }

    let couponReservationBound = false;
    let persistedOrderId = null;
    let result;
    try {
      const installment = interestFreeInstallment(quote.totalCents, payment.installments, {
        minimumInstallmentCents: payment.method === "credit_card"
          ? MIN_CARD_INSTALLMENT_CENTS
          : MIN_PIX_INSTALLMENT_CENTS,
      });
      if (payment.installments > 1 && !installment) {
        throw new CheckoutInputError("O parcelamento escolhido não está disponível.", "invalid_installments");
      }

      const customerId = await findOrCreateCustomer(
        asaasClient,
        buyer,
        key,
        environment.paymentReferencePrefix,
      );
      const providerPayment = await asaasClient.createPayment(paymentPayload({
        customerId,
        quote,
        payment,
        key,
        buyer,
        card: payment.card,
        referencePrefix: environment.paymentReferencePrefix,
      }));
      const orderId = providerId(providerPayment?.id);
      persistedOrderId = orderId;

      const successUrl = `${environment.publicOrigin}/checkout/sucesso/?order_id=${encodeURIComponent(orderId)}`;
      let updatedPayment = providerPayment;
      try {
        updatedPayment = await asaasClient.updatePayment(
          orderId,
          paymentCallbackPayload(providerPayment, successUrl),
        );
      } catch (callbackError) {
        console.error("Could not configure the Asaas return URL", {
          orderId,
          status: callbackError?.status,
          code: callbackError?.code,
        });
      }

      const localOrder = await store.createOrder({
        provider: "asaas",
        providerOrderId: orderId,
        providerGroupId: providerPayment?.installment
          ? providerId(providerPayment.installment, "installment id")
          : null,
        checkoutAttemptKey: quote.coupon ? key : null,
        status: normalizeAsaasPaymentStatus(updatedPayment?.status ?? providerPayment?.status),
        buyerEmail: buyer.email,
        buyerCpf: buyer.cpfCnpj,
        buyerName: buyer.name,
        buyerPhone: buyer.mobilePhone,
        buyerBirthDate: buyer.birthDate,
        buyerAddress: buyer.address,
        lmsBuyerUserId: quote.lms ? checkoutIdentity.userId : null,
        lmsRecipientUserId: quote.lms ? quote.recipientUserId : null,
        paymentMethod: payment.method,
        installments: payment.installments,
        installmentCents: installment?.installmentCents ?? quote.totalCents,
        couponCode: quote.coupon?.code ?? quote.couponCode ?? null,
        couponRedeemed: Boolean(quote.lms && quote.couponCode),
        subtotalCents: quote.subtotalCents,
        discountCents: quote.discountCents,
        totalCents: quote.totalCents,
        lines: quote.lines,
      });
      couponReservationBound = Boolean(quote.coupon && !quote.lms);
      // Rede de segurança: o webhook da Asaas pode confirmar o pagamento ANTES
      // do createOrder (Pix confirmando em segundos). Se a ordem já nasceu paga,
      // dispara a concessão de acesso aqui, com o pedido já enriquecido.
      if (localOrder.status === "paid" && onAccessGranted) {
        onAccessGranted(localOrder.id).catch((error) => {
          console.error("Could not grant access for reconciled checkout order", {
            orderId: localOrder.id,
            type: error?.name,
          });
        });
      }
      if (payment.method === "pix_installment") {
        try {
          await installmentService?.sync(localOrder);
        } catch (syncError) {
          console.error("Could not synchronize the new Asaas installment plan", {
            orderId,
            code: syncError?.code,
            type: syncError?.name,
          });
        }
      }

      if (payment.method === "pix" || payment.method === "pix_installment") {
        let pix = null;
        try {
          pix = publicPixInstructions(await asaasClient.getPixQrCode(orderId));
        } catch (pixError) {
          console.error("Asaas Pix instructions are still being prepared", {
            orderId,
            status: pixError?.status,
            code: pixError?.code,
          });
        }
        result = {
          status: 201,
          body: {
            orderId,
            status: normalizeAsaasPaymentStatus(updatedPayment?.status ?? providerPayment?.status),
            method: payment.method,
            installments: payment.installments,
            installmentCents: installment?.installmentCents ?? quote.totalCents,
            totalCents: quote.totalCents,
            ...(pix ? { pix } : { pixPending: true }),
          },
        };
      } else {
        result = {
          status: 201,
          body: {
            orderId,
            status: normalizeAsaasPaymentStatus(updatedPayment?.status ?? providerPayment?.status),
            method: "credit_card",
            installments: payment.installments,
            installmentCents: installment?.installmentCents ?? quote.totalCents,
            totalCents: quote.totalCents,
            message: normalizeAsaasPaymentStatus(updatedPayment?.status ?? providerPayment?.status) === "paid"
              ? "Pagamento aprovado."
              : "Pagamento recebido e em anÃ¡lise.",
          },
        };
      }
    } catch (error) {
      if (error instanceof CheckoutInputError || error instanceof CreditCardInputError) {
        if (quote.coupon && !quote.lms) await store.releaseCouponReservation(key);
        await store.abandonCheckoutAttempt(key);
        result = { status: 400, body: { error: error.code, message: error.message, retryable: true } };
      } else {
        if (quote.coupon && !quote.lms && !couponReservationBound) await store.releaseCouponReservation(key);
        if (!persistedOrderId) await store.abandonCheckoutAttempt(key);
        console.error("Asaas checkout failed", {
          endpoint: error?.endpoint,
          status: error?.status,
          code: error?.code,
          type: error?.name,
        });
        result = persistedOrderId ? {
          status: 202,
          body: {
            orderId: persistedOrderId,
            status: "processing",
            method: payment.method,
            totalCents: quote.totalCents,
            message: "Pedido recebido e em reconciliação com a Asaas.",
          },
        } : {
          status: 502,
          body: {
            error: "checkout_provider_error",
            message: error?.retryable
              ? "A Asaas está temporariamente indisponível. Tente novamente."
              : "O pagamento não pôde ser criado. Revise os dados e tente novamente.",
            retryable: true,
          },
        };
      }
    }

    await store.completeCheckoutAttempt(key, result);
    if (result.status >= 200 && result.status < 300 && checkoutIdentity.tokenId && typeof store.revokeCheckoutToken === "function") {
      await store.revokeCheckoutToken(checkoutIdentity.tokenId);
    }
    response.status(result.status).json(result.body);
  });

  // Recuperação do QR Code Pix sem criar uma segunda cobrança (o id do pedido
  // na Asaas é imprevisível, então a rota é aberta com rate limit).
  router.get("/orders/:orderId/pix", readLimiter, async (request, response) => {
    if (!requireProvider(response)) return;
    response.set("Cache-Control", "no-store");
    try {
      const orderId = providerId(request.params.orderId);
      const localOrder = await store.getOrderByProviderOrderId("asaas", orderId);
      if (!localOrder || !["pix", "pix_installment"].includes(localOrder.paymentMethod)) {
        response.status(404).json({
          error: "order_not_found",
          message: "Não encontramos este Pix.",
        });
        return;
      }
      const payment = await asaasClient.getPayment(orderId);
      const status = normalizeAsaasPaymentStatus(payment?.status);
      if (status === "paid") {
        response.json({ id: orderId, status });
        return;
      }
      try {
        const pix = publicPixInstructions(await asaasClient.getPixQrCode(orderId));
        if (pix) {
          response.json({ id: orderId, status, pix });
          return;
        }
      } catch (pixError) {
        if (![400, 404, 409].includes(Number(pixError?.status))) throw pixError;
      }
      response.status(202).json({ id: orderId, status, pixPending: true });
    } catch (error) {
      console.error("Asaas Pix retrieval failed", {
        endpoint: error?.endpoint,
        status: error?.status,
      });
      response.status(error?.status === 404 ? 404 : 502).json({
        error: "pix_retrieval_failed",
        message: "O Pix foi criado, mas o QR Code ainda não está disponível. Tente novamente em instantes.",
      });
    }
  });

  router.get("/orders/:orderId/installments", readLimiter, async (request, response) => {
    if (!requireProvider(response)) return;
    response.set("Cache-Control", "no-store");
    try {
      const orderId = providerId(request.params.orderId);
      const localOrder = await store.getOrderByProviderOrderId("asaas", orderId);
      if (!localOrder || localOrder.paymentMethod !== "pix_installment") {
        response.status(404).json({ error: "order_not_found", message: "Parcelamento nÃ£o encontrado." });
        return;
      }
      const plan = await installmentService.sync(localOrder);
      response.json({ id: orderId, status: localOrder.status, plan });
    } catch (error) {
      console.error("Asaas installment retrieval failed", { status: error?.status, code: error?.code });
      response.status(error?.status === 404 ? 404 : 502).json({
        error: "installment_retrieval_failed",
        message: "NÃ£o foi possÃ­vel atualizar as parcelas agora.",
      });
    }
  });

  router.get("/orders/:orderId/installments/:number/pix", readLimiter, async (request, response) => {
    if (!requireProvider(response)) return;
    response.set("Cache-Control", "no-store");
    try {
      const orderId = providerId(request.params.orderId);
      const number = Number(request.params.number);
      const localOrder = await store.getOrderByProviderOrderId("asaas", orderId);
      if (!localOrder || localOrder.paymentMethod !== "pix_installment" || !Number.isSafeInteger(number) || number < 1) {
        response.status(404).json({ error: "installment_not_found", message: "Parcela nÃ£o encontrada." });
        return;
      }
      await installmentService.sync(localOrder);
      const rows = await store.listPaymentInstallments(localOrder.id);
      const installment = rows.find((row) => Number(row.number) === number);
      if (!installment) {
        response.status(404).json({ error: "installment_not_found", message: "Parcela nÃ£o encontrada." });
        return;
      }
      if (installment.status === "paid") {
        response.json({ id: orderId, number, status: "paid" });
        return;
      }
      const pix = publicPixInstructions(await asaasClient.getPixQrCode(installment.providerPaymentId));
      if (!pix) {
        response.status(202).json({ id: orderId, number, status: installment.status, pixPending: true });
        return;
      }
      response.json({ id: orderId, number, status: installment.status, pix });
    } catch (error) {
      console.error("Asaas installment Pix retrieval failed", { status: error?.status, code: error?.code });
      response.status(error?.status === 404 ? 404 : 502).json({
        error: "installment_pix_retrieval_failed",
        message: "O Pix desta parcela ainda nÃ£o estÃ¡ disponÃ­vel.",
      });
    }
  });

  // Consulta de status sanitizada (usada pelo frontend para confirmar o
  // pagamento após o redirecionamento da Asaas).
  router.get("/orders/:orderId", readLimiter, async (request, response) => {
    if (!requireProvider(response)) return;
    let orderId;
    try {
      orderId = providerId(request.params.orderId);
      const payment = await asaasClient.getPayment(orderId);
      response.json({ id: providerId(payment?.id ?? orderId), status: normalizeAsaasPaymentStatus(payment?.status) });
    } catch (error) {
      console.error("Asaas payment retrieval failed", {
        endpoint: error?.endpoint,
        status: error?.status,
      });
      response.status(error?.status === 404 ? 404 : 502).json({
        error: "order_not_found",
        message: "Não encontramos este pedido na Asaas.",
      });
    }
  });

  return router;
}
