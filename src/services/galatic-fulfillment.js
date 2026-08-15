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
    country: "BR", postalCode: digits(value.postalCode ?? value.postal_code ?? value.cep ?? fallback.postalCode),
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

export function createGalaticFulfillmentService({ environment, store, enviaClient }) {
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
    const packages = order.items.map((item) => ({ type: "box", content: text(item.title, 80), amount: item.quantity,
      declaredValue: item.unit_amount_cents / 100, weight: item.weight_grams / 1000, weightUnit: "KG", lengthUnit: "CM",
      dimensions: { length: item.length_cm, width: item.width_cm, height: item.height_cm } }));
    const result = await enviaClient.generateLabel({ origin, destination, packages,
      shipment: { type: 1, carrier: selected.carrier, service: selected.service },
      settings: { printFormat: "PDF", printSize: "STOCK_4X6", currency: "BRL", comments: `Galatic ${order.id}` } });
    const data = Array.isArray(result?.data) ? result.data[0] : result?.data;
    const trackingCode = text(data?.trackingNumber, 100);
    if (!trackingCode) throw Object.assign(new Error("envia_invalid_label_response"), { code: "envia_invalid_label_response" });
    const stored = await store.saveShipment(order.id, { providerShipmentId: text(data?.shipmentId, 100) || null,
      carrier: text(data?.carrier ?? selected.carrier, 60), service: text(data?.service ?? selected.service, 100), trackingCode,
      labelUrl: text(data?.label, 1500) || null, trackUrl: text(data?.trackUrl, 1500) || null,
      costCents: Number.isFinite(Number(data?.totalPrice)) ? Math.round(Number(data.totalPrice) * 100) : null,
      currency: text(data?.currency, 3).toUpperCase() || "BRL" });
    return { created: true, shipment: shipmentView(stored) };
  }

  async function refresh(orderId) {
    const shipment = await store.shipmentForOrder(orderId);
    if (!shipment) throw Object.assign(new Error("shipment_not_found"), { code: "shipment_not_found" });
    const result = await enviaClient.track([shipment.tracking_code]);
    const data = Array.isArray(result?.data) ? result.data[0] : result?.data;
    const status = normalizeEnviaStatus(data?.status);
    await store.updateShipmentFromEvent({ eventId: `poll:${shipment.tracking_code}:${text(data?.status, 80)}:${text(data?.events?.[0]?.timestamp, 80)}`,
      eventType: "tracking.poll", trackingCode: shipment.tracking_code, status,
      description: text(data?.events?.[0]?.description ?? data?.status, 500) });
    return store.shipmentForOrder(orderId);
  }

  async function cancel(orderId) {
    const shipment = await store.shipmentForOrder(orderId);
    if (!shipment) throw Object.assign(new Error("shipment_not_found"), { code: "shipment_not_found" });
    if (shipment.canceled_at) return { canceled: true, shipment: shipmentView(shipment) };
    const result = await enviaClient.cancel({ carrier: shipment.carrier, trackingNumber: shipment.tracking_code });
    await store.cancelShipment(orderId, result?.data?.balanceReturned ? "Etiqueta cancelada; saldo devolvido pela Envia." : "Cancelamento da etiqueta solicitado à Envia.");
    return { canceled: true, balance_returned: Boolean(result?.data?.balanceReturned), shipment: shipmentView(await store.shipmentForOrder(orderId)) };
  }

  return { createLabel, refresh, cancel };
}

export function normalizeEnviaStatus(value) {
  const status = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/delivered|entregue/.test(status)) return "delivered";
  if (/out_for_delivery|saiu_para_entrega/.test(status)) return "out_for_delivery";
  if (/exception|failed|incidente|problema/.test(status)) return "delivery_exception";
  if (/return|devol/.test(status)) return "returned";
  if (/transit|posted|collected|picked|postado|trânsito|transito/.test(status)) return "in_transit";
  if (/cancel/.test(status)) return "shipment_canceled";
  return "label_created";
}
