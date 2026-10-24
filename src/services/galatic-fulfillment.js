import { loadGalaticPaymentProof } from "./galatic-payment-proof.js";
import { closedGalaticFinancialGate } from "./galatic-financial-gate.js";
import { galaticPostcode, assertShippingAddress } from "../domain/galatic-address.js";
const digits = (value) => String(value ?? "").replace(/\D/g, "");
const text = (value, maximum = 180) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);

function providerAddress(value, fallback = {}) {
  return {
    name: text(value.recipient_name ?? value.recipientName ?? value.name ?? fallback.name),
    company: text(value.company ?? fallback.company ?? fallback.name),
    email: text(value.email ?? fallback.email), phone: digits(value.phone ?? fallback.phone),
    street: text(value.street ?? value.logradouro ?? fallback.street), number: text(value.number ?? value.numero ?? fallback.number, 30) || "S/N",
    complement: text(value.complement ?? value.complemento, 120), district: text(value.district ?? value.bairro ?? fallback.district),
    city: text(value.city ?? value.cidade ?? fallback.city), state: text(value.state ?? value.uf ?? fallback.state, 2).toUpperCase(),
    country: "BR", postalCode: galaticPostcode(value) || galaticPostcode(fallback),
    identificationNumber: digits(value.federal_tax_id ?? value.document ?? fallback.taxId),
  };
}

function splitService(value) {
  const [carrier, ...parts] = String(value ?? "").split(":");
  const service = parts.join(":");
  if (!carrier || !service) throw Object.assign(new Error("shipping_service_missing"), { code: "shipping_service_missing" });
  return { carrier, service };
}

function shipmentView(row) {
  return { order_id: row.order_id, carrier: row.carrier, service: row.service, tracking_code: row.tracking_code,
    label_url: row.label_url, tracking_url: row.track_url, status: row.status, environment_cost: row.provider_cost_cents,
    currency: row.currency, created_at: row.created_at };
}

export function createGalaticFulfillmentService({ environment, store, enviaClient, paymentProfiles = null, notifications = null, financialGate = closedGalaticFinancialGate }) {
  async function verifyProductionPayment(order) {
    const unverified = () => Object.assign(new Error("shipping_payment_unverified"), { code: "shipping_payment_unverified" });
    try {
      const bound = await paymentProfiles.getVerifiedClient({ profileId: order.payment_profile_id }, "fulfillment");
      if (environment.galaticEnviaEnvironment === "production" && (bound.environment !== "production" || !bound.commercialApproved)) throw unverified();
      if (order.payment_provider !== "asaas" || !["pix", "credit_card"].includes(order.payment_method ?? "pix")) throw unverified();
      const proof = await loadGalaticPaymentProof({ store, paymentProfiles,
        order: { id: order.id, profileId: order.payment_profile_id }, capability: "fulfillment" });
      if (!proof.paid) throw unverified();
      if (environment.galaticEnviaEnvironment === "production"
        && (proof.environment !== "production" || !proof.commercialApproved)) throw unverified();
      if (order.payment_provider_order_id !== proof.providerOrderId || order.payment_provider_group_id !== proof.providerGroupId
        || Number(order.total_cents) !== proof.operation.pricing.totalCents
        || (order.payment_method !== undefined && order.payment_method !== proof.operation.order.method)
        || (order.installments !== undefined && Number(order.installments) !== proof.operation.order.installments)) throw unverified();
    } catch { throw unverified(); }
  }
  async function notifyShipping(orderId, key, status, trackingCode, description) {
    if (store.enqueueNotification) return store.enqueueNotification(key, orderId, "sendShippingUpdate", { status, trackingCode, description });
    if (!notifications?.sendShippingUpdate || !store.getOrderNotification) return;
    const notification = await store.getOrderNotification(orderId);
    if (!notification || !(await store.claimNotification?.(key))) return;
    notifications.sendShippingUpdate({ ...notification, status, trackingCode, description }).catch(async () => {
      await store.releaseNotification?.(key).catch(() => {});
    });
  }

  async function createLabel(orderId) {
    const existing = await store.shipmentForOrder(orderId);
    if (existing) return { created: false, shipment: shipmentView(existing) };
    if (!enviaClient?.ready || !environment.galaticShippingOrigin) throw Object.assign(new Error("shipping_unavailable"), { code: "shipping_unavailable" });
    const order = await store.shipmentCreationContext(orderId);
    if (!order) throw Object.assign(new Error("order_not_found"), { code: "order_not_found" });
    if (order.payment_status !== "paid") throw Object.assign(new Error("order_not_paid"), { code: "order_not_paid" });
    const selected = splitService(order.service_code);
    const origin = providerAddress(environment.galaticShippingOrigin, environment.galaticShippingOrigin);
    const destination = providerAddress({ ...order.shipping_address, name: order.buyer_name, email: order.buyer_email,
      phone: order.buyer_phone, document: order.buyer_document });
    assertShippingAddress(origin);
    assertShippingAddress(destination);
    const packages = order.items.map((item) => ({ type: "box", content: text(item.title, 80), amount: item.quantity,
      declaredValue: item.unit_amount_cents / 100, weight: item.weight_grams / 1000, weightUnit: "KG", lengthUnit: "CM",
      dimensions: { length: item.length_cm, width: item.width_cm, height: item.height_cm } }));
    if (!packages.length || packages.some((item) => !Number.isInteger(item.amount) || item.amount < 1
      || ![item.weight, item.dimensions.length, item.dimensions.width, item.dimensions.height].every((value) => Number(value) > 0))) {
      throw Object.assign(new Error("invalid_shipping_packages"), { code: "invalid_shipping_packages" });
    }
    await verifyProductionPayment(order);
    const operationId = randomUUID();
    const claim = await store.claimShipmentCreation(order.id, operationId);
    if (!claim.claimed) {
      const code = claim.status === "needs_reconciliation" ? "shipping_needs_reconciliation" : "shipping_in_progress";
      throw Object.assign(new Error(code), { code });
    }
    let stored;
    let trackingCode;
    try {
      await paymentProfiles.getVerifiedClient({ profileId: order.payment_profile_id }, "fulfillment");
      const result = await enviaClient.generateLabel({ origin, destination, packages,
        shipment: { type: 1, carrier: selected.carrier, service: selected.service },
        settings: { printFormat: "PDF", printSize: "STOCK_4X6", currency: "BRL", comments: `Galatic ${order.id}` } });
      const data = Array.isArray(result?.data) ? result.data[0] : result?.data;
      trackingCode = text(data?.trackingNumber, 100);
      if (!trackingCode) throw Object.assign(new Error("envia_invalid_label_response"), { code: "envia_invalid_label_response" });
      financialGate.assertEnabled();
      stored = await store.saveShipment(order.id, { providerShipmentId: text(data?.shipmentId, 100) || null,
        carrier: text(data?.carrier ?? selected.carrier, 60), service: text(data?.service ?? selected.service, 100), trackingCode,
        labelUrl: text(data?.label, 1500) || null, trackUrl: text(data?.trackUrl, 1500) || null,
        costCents: Number.isFinite(Number(data?.totalPrice)) ? Math.round(Number(data.totalPrice) * 100) : null,
        currency: text(data?.currency, 3).toUpperCase() || "BRL" });
      await store.completeShipmentCreation(order.id, operationId, stored?.provider_shipment_id ?? null);
    } catch (error) {
      // A chamada externa pode ter sido concluída mesmo quando a resposta se perde.
      // Não libera para retry automático: uma pessoa deve reconciliar com a Envia.
      await store.markShipmentCreationUncertain(order.id, operationId, error?.code ?? error?.name ?? "unknown").catch(() => {});
      await store.recordOperationalAlert?.({ type: "shipment_reconciliation_required", source: "galatic-fulfillment",
        summary: "A emissão de etiqueta precisa ser reconciliada antes de nova tentativa.",
        context: { orderId: order.id, operationId, code: error?.code ?? error?.name ?? "unknown" } }).catch(() => {});
      throw error;
    }
    const notificationKey = `shipping:label_created:${order.id}`;
    await notifyShipping(order.id, notificationKey, "label_created", trackingCode,
      "A etiqueta foi criada e o pedido seguirá para postagem.");
    return { created: true, shipment: shipmentView(stored) };
  }

  async function refresh(orderId) {
    const shipment = await store.shipmentForOrder(orderId);
    if (!shipment) throw Object.assign(new Error("shipment_not_found"), { code: "shipment_not_found" });
    const result = await enviaClient.track([shipment.tracking_code]);
    const data = Array.isArray(result?.data) ? result.data[0] : result?.data;
    const status = normalizeEnviaStatus(data?.status);
    const eventId = `poll:${shipment.tracking_code}:${text(data?.status, 80)}:${text(data?.events?.[0]?.timestamp, 80)}`;
    const description = text(data?.events?.[0]?.description ?? data?.status, 500);
    financialGate.assertEnabled();
    const updated = await store.updateShipmentFromEvent({ eventId,
      eventType: "tracking.poll", trackingCode: shipment.tracking_code, status,
      description, occurredAt: data?.events?.[0]?.timestamp ?? null });
    if (updated?.updated) await notifyShipping(orderId, `shipping:${eventId}:${orderId}`, status,
      shipment.tracking_code, description);
    return store.shipmentForOrder(orderId);
  }

  async function cancel(orderId) {
    const shipment = await store.shipmentForOrder(orderId);
    if (!shipment) throw Object.assign(new Error("shipment_not_found"), { code: "shipment_not_found" });
    if (shipment.canceled_at) return { canceled: true, shipment: shipmentView(shipment) };
    const result = await enviaClient.cancel({ carrier: shipment.carrier, trackingNumber: shipment.tracking_code });
    const description = result?.data?.balanceReturned ? "Etiqueta cancelada; saldo devolvido pela Envia." : "Cancelamento da etiqueta solicitado à Envia.";
    financialGate.assertEnabled();
    await store.cancelShipment(orderId, description);
    await notifyShipping(orderId, `shipping:shipment_canceled:${orderId}`, "shipment_canceled",
      shipment.tracking_code, description);
    return { canceled: true, balance_returned: Boolean(result?.data?.balanceReturned), shipment: shipmentView(await store.shipmentForOrder(orderId)) };
  }

  return Object.freeze({ verifyProductionPayment, createLabel: (...args) => financialGate.run(() => createLabel(...args)),
    refresh: (...args) => financialGate.run(() => refresh(...args)),
    cancel: (...args) => financialGate.run(() => cancel(...args)) });
}

export function normalizeEnviaStatus(value) {
  const status = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = { delivered: "delivered", entregue: "delivered", out_for_delivery: "out_for_delivery", saiu_para_entrega: "out_for_delivery",
    exception: "delivery_exception", failed: "delivery_exception", not_delivered: "delivery_exception", delivery_exception: "delivery_exception",
    returned: "returned", return: "returned", devolvido: "returned", in_transit: "in_transit", transit: "in_transit", posted: "in_transit",
    collected: "in_transit", picked_up: "in_transit", postado: "in_transit", canceled: "shipment_canceled", cancelled: "shipment_canceled",
    shipment_canceled: "shipment_canceled", label_created: "label_created" };
  return aliases[status] ?? "unknown";
}

import { randomUUID } from "node:crypto";
