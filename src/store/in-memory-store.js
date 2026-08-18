import crypto from "node:crypto";
import { resolveOrderStatus } from "./order-status.js";
import { summarizeInstallmentPlan } from "../domain/payment-status.js";
import catalogSeed from "../domain/catalog-data.json" with { type: "json" };

const iso = (value) => value ? new Date(value).toISOString() : null;

function seedProducts() {
  return catalogSeed.map((product, index) => ({
    slug: product.slug,
    sourceTag: product.sourceTag,
    title: product.title,
    description: product.description ?? "",
    categoryId: product.categoryId ?? "outros",
    kind: product.kind ?? "course",
    accent: product.accent ?? null,
    cohort: product.cohort ?? null,
    year: product.year ?? null,
    officialPriceCents: Number.isSafeInteger(product.officialPriceCents) ? product.officialPriceCents : product.priceCents,
    priceCents: product.priceCents,
    featured: Boolean(product.featured),
    active: product.active !== false,
    availability: product.availability === "sold_out" ? "sold_out" : "available",
    purchasable: product.purchasable !== false && product.availability !== "sold_out",
    sortOrder: index,
    imageUrl: null,
    image600Url: null,
    imageAlt: null,
    keywords: Array.isArray(product.keywords) ? product.keywords : [],
  }));
}

export function createInMemoryStore() {
  const id = () => crypto.randomUUID();
  const products = seedProducts();
  const coupons = new Map();
  const orders = new Map();
  const orderItems = new Map();
  const installmentsByOrder = new Map();
  const redemptions = new Map();
  const reservations = new Map();
  const attempts = new Map();
  const webhookEvents = new Set();
  const operationalAlerts = [];
  const artMappings = new Map();
  const artActivations = [];

  function couponView(code) {
    const value = coupons.get(code);
    if (!value) return null;
    let total = 0;
    for (const redeemedCode of redemptions.values()) if (redeemedCode === code) total += 1;
    return { ...value, redemptions: total };
  }

  function summarizeInstallments(order) {
    const rows = installmentsByOrder.get(order.id) ?? [];
    const summary = summarizeInstallmentPlan(rows, Number(order.installments ?? 0));
    const hadAccess = Boolean(order.accessGrantedAt);
    order.status = summary.status;
    order.paidCents = summary.paidCents;
    order.paidInstallments = summary.paidInstallments;
    if (!hadAccess && summary.paidInstallments > 0) order.accessGrantedAt = new Date().toISOString();
    if (summary.paidInstallments > 0) redeemCouponFor(order);
    return { id: order.id, status: order.status, previousStatus: order.previousStatus ?? null, accessGrantedNow: !hadAccess && summary.paidInstallments > 0 };
  }

  function redeemCouponFor(order) {
    if (!order.couponCode || order.couponRedeemed) return;
    redemptions.set(order.id, order.couponCode);
    order.couponRedeemed = true;
    for (const [key, reservation] of reservations) {
      if (reservation.provider === order.provider && reservation.providerOrderId === order.providerOrderId) {
        reservations.delete(key);
      }
    }
  }

  return {
    async ensureSchema() {},
    async recordOperationalAlert(value) { operationalAlerts.push({ ...value, occurredAt: new Date().toISOString() }); },
    async close() {},
    async listCatalogProducts({ activeOnly = true } = {}) {
      return products.filter((product) => !activeOnly || product.active);
    },
    async listCoupons() {
      return [...coupons.keys()].map((code) => couponView(code)).sort((a, b) => a.code.localeCompare(b.code));
    },
    async getCoupon(code) {
      return couponView(code);
    },
    async saveCoupon(value) {
      const next = {
        id: coupons.get(value.code)?.id ?? id(),
        code: value.code,
        discountBps: value.discountBps,
        active: value.active !== false,
        startsAt: value.startsAt ?? null,
        endsAt: value.endsAt ?? null,
        maxRedemptions: value.maxRedemptions ?? null,
        productSlugs: value.productSlugs ?? [],
        createdAt: coupons.get(value.code)?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      coupons.set(value.code, next);
      return couponView(value.code);
    },
    async getEligibleCoupon(code, slugs) {
      const c = couponView(code);
      if (!c || !c.active || (c.startsAt && +new Date(c.startsAt) > Date.now()) || (c.endsAt && +new Date(c.endsAt) <= Date.now()) || (c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions) || (c.productSlugs.length && !slugs.every((slug) => c.productSlugs.includes(slug)))) return null;
      return c;
    },
    async beginCheckoutAttempt(key, fingerprint) {
      const existing = attempts.get(key);
      if (!existing) {
        attempts.set(key, { fingerprint, state: "pending", response: null, expiresAt: null });
        return { kind: "new" };
      }
      if (existing.state === "complete" && existing.expiresAt && +new Date(existing.expiresAt) <= Date.now()) {
        attempts.delete(key);
        return this.beginCheckoutAttempt(key, fingerprint);
      }
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      return existing.state === "complete" && existing.response
        ? { kind: "replay", response: existing.response }
        : { kind: "pending" };
    },
    async completeCheckoutAttempt(key, response) {
      const attempt = attempts.get(key);
      if (!attempt) return;
      attempt.state = "complete";
      attempt.response = response;
      attempt.expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    },
    async abandonCheckoutAttempt(key) {
      const attempt = attempts.get(key);
      if (attempt?.state === "pending") attempts.delete(key);
    },
    async reserveCoupon(code, attemptKey, slugs = []) {
      const c = await this.getEligibleCoupon(code, slugs);
      if (!c) return null;
      const reservedCount = [...reservations.values()].filter((reservation) => reservation.code === code).length;
      if (c.maxRedemptions !== null && c.redemptions + reservedCount >= c.maxRedemptions) return null;
      reservations.set(attemptKey, { code, provider: null, providerOrderId: null, expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
      return c;
    },
    async releaseCouponReservation(attemptKey) {
      reservations.delete(attemptKey);
    },
    async createOrder(order) {
      let existing = null;
      for (const candidate of orders.values()) {
        if (candidate.provider === order.provider && (candidate.providerOrderId === order.providerOrderId || (order.providerGroupId && candidate.providerGroupId === order.providerGroupId))) {
          existing = candidate;
          break;
        }
      }
      const orderId = existing?.id ?? id();
      const status = resolveOrderStatus(existing?.status, order.status);
      const record = {
        id: orderId,
        provider: order.provider,
        providerOrderId: order.providerOrderId,
        providerGroupId: order.providerGroupId,
        providerGroupId: order.providerGroupId ?? null,
        status,
        previousStatus: existing?.status ?? null,
        buyerEmail: order.buyerEmail,
        buyerCpf: order.buyerCpf ?? null,
        buyerName: order.buyerName ?? null,
        buyerPhone: order.buyerPhone ?? null,
        buyerBirthDate: order.buyerBirthDate ?? null,
        buyerAddress: order.buyerAddress ?? null,
        paymentMethod: order.paymentMethod ?? null,
        installments: order.installments ?? null,
        installmentCents: order.installmentCents ?? null,
        subtotalCents: order.subtotalCents,
        discountCents: order.discountCents,
        totalCents: order.totalCents,
        paidCents: existing?.paidCents ?? 0,
        paidInstallments: existing?.paidInstallments ?? 0,
        accessGrantedAt: existing?.accessGrantedAt ?? null,
        couponCode: order.couponCode,
        couponRedeemed: existing?.couponRedeemed ?? false,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (status === "paid") {
        record.paidCents = record.totalCents;
        record.paidInstallments = 1;
        record.accessGrantedAt = record.accessGrantedAt ?? new Date().toISOString();
      }
      orders.set(orderId, record);
      orderItems.set(orderId, order.lines.map((line) => ({
        id: id(),
        orderId,
        courseSlug: line.product.slug,
        title: line.product.title,
        basePriceCents: line.basePriceCents,
        discountCents: line.discountCents,
        finalPriceCents: line.finalPriceCents,
      })));
      if (order.checkoutAttemptKey) {
        const reservation = reservations.get(order.checkoutAttemptKey);
        if (!reservation) throw new Error("Coupon reservation is missing.");
        reservation.provider = order.provider;
        reservation.providerOrderId = order.providerOrderId;
      }
      if (status === "paid") redeemCouponFor(record);
      return { id: orderId, ...order, status };
    },
    async updateOrderFromWebhook({ provider, providerOrderId, providerGroupId, status, eventId }) {
      if (eventId && webhookEvents.has(eventId)) return { duplicate: true };
      let order = [...orders.values()].find((candidate) => candidate.provider === provider && candidate.providerOrderId === providerOrderId) ?? null;
      if (!order && providerGroupId) {
        order = [...orders.values()].find((candidate) => candidate.provider === provider && candidate.providerGroupId === providerGroupId) ?? null;
      }
      const previousStatus = order?.status ?? null;
      if (!order) {
        const reconciledId = id();
        order = {
          id: reconciledId,
          provider,
          providerOrderId,
          providerGroupId: providerGroupId ?? null,
          status,
          previousStatus: null,
          buyerEmail: null,
          buyerCpf: null,
          buyerName: null,
          buyerPhone: null,
          buyerBirthDate: null,
          buyerAddress: null,
          paymentMethod: null,
          installments: null,
          installmentCents: null,
          subtotalCents: 0,
          discountCents: 0,
          totalCents: 0,
          paidCents: 0,
          paidInstallments: 0,
          accessGrantedAt: null,
          couponCode: null,
          couponRedeemed: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        orders.set(reconciledId, order);
      }
      const nextStatus = resolveOrderStatus(order.status, status);
      if (eventId) webhookEvents.add(eventId);
      order.previousStatus = previousStatus;
      order.status = nextStatus;
      order.updatedAt = new Date().toISOString();
      if (nextStatus === "paid") {
        order.paidCents = order.totalCents;
        order.paidInstallments = 1;
        order.accessGrantedAt = order.accessGrantedAt ?? new Date().toISOString();
      }
      if (nextStatus === "paid") redeemCouponFor(order);
      if (["failed", "refunded", "chargeback"].includes(nextStatus)) {
        for (const [key, reservation] of reservations) {
          if (reservation.provider === provider && reservation.providerOrderId === order.providerOrderId) reservations.delete(key);
        }
      }
      return { id: order.id, status: nextStatus, previousStatus };
    },
    async replacePaymentInstallments(orderId, providerGroupId, rows) {
      const order = orders.get(orderId);
      if (!order || order.provider !== "asaas" || order.providerGroupId !== providerGroupId) {
        throw new Error("Installment order was not found.");
      }
      installmentsByOrder.set(orderId, rows.map((row) => ({ ...row })));
      return summarizeInstallments(order);
    },
    async listPaymentInstallments(orderId) {
      return [...(installmentsByOrder.get(orderId) ?? [])]
        .sort((a, b) => a.number - b.number)
        .map((row) => ({
          providerPaymentId: row.providerPaymentId,
          providerGroupId: row.providerGroupId,
          number: row.number,
          status: row.status,
          dueDate: row.dueDate,
          amountCents: row.amountCents,
          paymentUrl: row.paymentUrl,
          paidAt: iso(row.paidAt),
        }));
    },
    async updatePaymentInstallmentFromWebhook({ provider, providerOrderId, providerGroupId, installment, eventId }) {
      if (eventId && webhookEvents.has(eventId)) return { duplicate: true };
      let order = [...orders.values()].find((candidate) => candidate.provider === provider && (candidate.providerOrderId === providerOrderId || candidate.providerGroupId === providerGroupId)) ?? null;
      if (!order) {
        const reconciledId = id();
        order = {
          id: reconciledId,
          provider,
          providerOrderId,
          providerGroupId,
          status: "processing",
          previousStatus: null,
          buyerEmail: null,
          buyerCpf: null,
          buyerName: null,
          buyerPhone: null,
          buyerBirthDate: null,
          buyerAddress: null,
          paymentMethod: null,
          installments: null,
          installmentCents: null,
          subtotalCents: 0,
          discountCents: 0,
          totalCents: 0,
          paidCents: 0,
          paidInstallments: 0,
          accessGrantedAt: null,
          couponCode: null,
          couponRedeemed: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        orders.set(reconciledId, order);
      }
      if (eventId) webhookEvents.add(eventId);
      const rows = installmentsByOrder.get(order.id) ?? [];
      const existingIndex = rows.findIndex((row) => row.providerPaymentId === installment.providerPaymentId);
      if (existingIndex >= 0) rows[existingIndex] = { ...installment };
      else rows.push({ ...installment });
      installmentsByOrder.set(order.id, rows);
      return summarizeInstallments(order);
    },
    async listOrders({ limit = 50 } = {}) {
      return [...orders.values()]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, limit)
        .map((order) => ({
          id: order.id,
          provider: order.provider,
          providerOrderId: order.providerOrderId,
          buyerEmail: order.buyerEmail,
          status: order.status,
          paymentMethod: order.paymentMethod,
          installments: order.installments,
          paidInstallments: order.paidInstallments,
          subtotalCents: order.subtotalCents,
          discountCents: order.discountCents,
          paidCents: order.paidCents,
          totalCents: order.totalCents,
          couponCode: order.couponCode,
          items: (orderItems.get(order.id) ?? []).length,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
        }));
    },
    async getOrderWithItems(orderId) {
      const order = orders.get(orderId);
      if (!order) return null;
      return {
        id: order.id,
        buyerEmail: order.buyerEmail,
        buyerCpf: order.buyerCpf,
        buyerName: order.buyerName,
        buyerPhone: order.buyerPhone,
        buyerBirthDate: order.buyerBirthDate,
        buyerAddress: order.buyerAddress,
        items: (orderItems.get(orderId) ?? []).map((item) => ({ id: item.id, courseSlug: item.courseSlug, title: item.title })),
      };
    },
    async getOrderByProviderOrderId(provider, providerOrderId) {
      const order = [...orders.values()].find((candidate) => candidate.provider === provider && candidate.providerOrderId === providerOrderId);
      if (!order) return null;
      return {
        id: order.id,
        provider: order.provider,
        providerOrderId: order.providerOrderId,
        status: order.status,
        paymentMethod: order.paymentMethod,
        installments: Number(order.installments ?? 0),
        installmentCents: order.installmentCents,
        totalCents: order.totalCents,
      };
    },
    // ------------------------------------------------------------------
    // Integração ART (modo local/desenvolvimento)
    // ------------------------------------------------------------------
    async listArtMappings({ activeOnly = true } = {}) {
      return [...artMappings.values()]
        .filter((mapping) => !activeOnly || mapping.active)
        .map((mapping) => ({ ...mapping }));
    },
    async getArtMapping(courseId) {
      const mapping = artMappings.get(Number(courseId));
      return mapping && mapping.active ? { ...mapping } : null;
    },
    async saveArtMapping(mapping) {
      const courseId = Number(mapping.courseId);
      const next = {
        courseId,
        artTag: String(mapping.artTag ?? ""),
        artIdCurso: Number(mapping.artIdCurso),
        artTurma: Number(mapping.artTurma),
        active: mapping.active !== false,
      };
      artMappings.set(courseId, next);
      return { ...next };
    },
    async deleteArtMapping(courseId) {
      const existing = artMappings.get(Number(courseId));
      if (existing) { existing.active = false; artMappings.set(Number(courseId), existing); }
      return true;
    },
    async recordArtActivation(entry) {
      const existing = artActivations.find((activation) => activation.orderId === entry.orderId && activation.orderItemId === entry.orderItemId);
      if (existing) {
        // retryCount/nextRetryAt indefinidos = preservar o valor gravado:
        // regravação pelo serviço não pode zerar contador/backoff do worker.
        const merged = { ...entry };
        if (merged.retryCount == null) merged.retryCount = existing.retryCount ?? 0;
        if (merged.nextRetryAt == null) merged.nextRetryAt = existing.nextRetryAt ?? null;
        Object.assign(existing, merged, { updatedAt: new Date().toISOString() });
        return { id: existing.id, status: entry.status, updated: true };
      }
      const record = {
        id: artActivations.length + 1,
        createdAt: new Date().toISOString(),
        ...entry,
        retryCount: entry.retryCount ?? 0,
        nextRetryAt: entry.nextRetryAt ?? null,
      };
      artActivations.push(record);
      return { id: record.id, status: entry.status, updated: false };
    },
    async listArtActivationsPendingRetry({ limit = 50, maxRetries = 8 } = {}) {
      const now = Date.now();
      return artActivations
        .filter((activation) => ["existing_account_no_access", "failed", "error"].includes(activation.status)
          && Number(activation.retryCount ?? 0) < maxRetries
          && (!activation.nextRetryAt || new Date(activation.nextRetryAt).getTime() <= now))
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((activation) => ({
          id: activation.id,
          orderId: activation.orderId,
          orderItemId: activation.orderItemId ?? null,
          courseId: activation.courseId,
          lmsUserId: activation.lmsUserId,
          artEmail: activation.artEmail,
          artTag: activation.artTag,
          status: activation.status,
          retryCount: Number(activation.retryCount ?? 0),
          nextRetryAt: activation.nextRetryAt ?? null,
          flippedOrders: activation.flippedOrders ?? [],
        }));
    },
    async getArtActivation(orderId, orderItemId) {
      const existing = artActivations.find((activation) => activation.orderId === orderId && activation.orderItemId === orderItemId);
      return existing ? { id: existing.id, status: existing.status, artProfileId: existing.artProfileId ?? null } : null;
    },
    async updateArtActivationRetry(activationId, { status, retryCount, nextRetryAt, result = null, errorMessage = null, flippedOrders = null }) {
      const activation = artActivations.find((entry) => entry.id === activationId);
      if (!activation) return false;
      activation.status = status;
      activation.retryCount = retryCount;
      activation.nextRetryAt = nextRetryAt ?? null;
      if (result !== null) activation.result = result;
      if (errorMessage !== null) activation.errorMessage = errorMessage;
      if (flippedOrders !== null) activation.flippedOrders = flippedOrders;
      return true;
    },
    async listArtActivations({ limit = 50, status = null } = {}) {
      const rows = artActivations
        .filter((activation) => !status || activation.status === status)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
      return rows.map((activation) => ({
        id: activation.id,
        orderId: activation.orderId,
        orderItemId: activation.orderItemId ?? null,
        courseId: activation.courseId,
        lmsUserId: activation.lmsUserId,
        artEmail: activation.artEmail,
        artProfileId: activation.artProfileId ?? null,
        artTag: activation.artTag,
        status: activation.status,
        result: activation.result ?? null,
        errorMessage: activation.errorMessage ?? null,
        flippedOrders: activation.flippedOrders ?? [],
        createdAt: activation.createdAt,
      }));
    },
    async getOrderRecipient(orderId) {
      const order = orders.get(orderId);
      if (!order) return null;
      return {
        orderId: order.id,
        lmsRecipientUserId: order.lmsRecipientUserId ? Number(order.lmsRecipientUserId) : null,
        email: String(order.buyerEmail ?? "").trim().toLowerCase(),
        cpf: String(order.buyerCpf ?? "").replace(/\D/g, ""),
        name: String(order.buyerName ?? "").trim(),
      };
    },
    async getOrderItemsForArt(orderId) {
      return (orderItems.get(orderId) ?? []).map((item) => ({
        id: item.id,
        courseId: item.courseId ?? null,
        courseSlug: item.courseSlug,
        title: item.title,
      }));
    },
  };
}
