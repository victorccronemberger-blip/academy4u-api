import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { getEnvironment } from "../src/config/environment.js";
import { createEnviaWebhookHandler } from "../src/routes/envia-webhook.js";
import { createGalaticFulfillmentService } from "../src/services/galatic-fulfillment.js";

test("keeps Envia in sandbox unless production is explicitly selected", () => {
  const sandbox = getEnvironment({ GALATIC_ENVIA_API_KEY: "test" });
  assert.equal(sandbox.galaticEnviaEnvironment, "sandbox");
  assert.equal(sandbox.galaticEnviaApiOrigin, "https://api-test.envia.com");
  const production = getEnvironment({ GALATIC_ENVIA_API_KEY: "live", GALATIC_ENVIA_ENVIRONMENT: "production" });
  assert.equal(production.galaticEnviaApiOrigin, "https://api.envia.com");
  assert.throws(() => getEnvironment({ GALATIC_ENVIA_ENVIRONMENT: "preview" }));
});

test("creates one paid-order label and reuses it on retry", async () => {
  let stored = null; let operation = null; const providerCalls = [];
  const store = {
    shipmentForOrder: async () => stored,
    claimShipmentCreation: async (_orderId, operationId) => operation ? { claimed: false, status: operation.status }
      : ((operation = { operationId, status: "in_progress" }), { claimed: true }),
    completeShipmentCreation: async () => { operation.status = "completed"; return true; },
    markShipmentCreationUncertain: async () => { operation.status = "needs_reconciliation"; return true; },
    shipmentCreationContext: async () => ({ id: "order-1", payment_status: "paid", buyer_name: "Cliente",
      buyer_email: "cliente@example.com", buyer_phone: "11999999999", buyer_document: "52998224725",
      service_code: "correios:pac", shipping_address: { street: "Rua B", number: "2", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
      items: [{ title: "Jogo", quantity: 1, unit_amount_cents: 12000, weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 }] }),
    saveShipment: async (orderId, value) => (stored = { order_id: orderId, ...value, tracking_code: value.trackingCode,
      label_url: value.labelUrl, track_url: value.trackUrl, provider_cost_cents: value.costCents, status: "label_created", created_at: "2026-08-15" }),
  };
  const enviaClient = { ready: true, generateLabel: async (payload) => { providerCalls.push(payload); return { data: [{ shipmentId: 10,
    carrier: "correios", service: "pac", trackingNumber: "BR123", label: "https://files.envia.com/label.pdf",
    trackUrl: "https://tracking.envia.com/BR123", totalPrice: 25, currency: "BRL" }] }; } };
  const environment = { galaticShippingOrigin: { name: "Galatic", email: "loja@example.com", phone: "11999999999", street: "Rua A",
    number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000", taxId: "11222333000181" } };
  const service = createGalaticFulfillmentService({ environment, store, enviaClient });
  assert.equal((await service.createLabel("order-1")).created, true);
  assert.equal((await service.createLabel("order-1")).created, false);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0].shipment, { type: 1, carrier: "correios", service: "pac" });
});

test("serializes concurrent label requests before calling Envia", async () => {
  let releaseProvider; let operation = null; let providerCalls = 0; let stored = null;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const context = { id: "order-race", payment_status: "paid", buyer_name: "Cliente", buyer_email: "c@example.com",
    buyer_phone: "11999999999", buyer_document: "52998224725", service_code: "correios:pac",
    shipping_address: { street: "Rua B", number: "2", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
    items: [{ title: "Jogo", quantity: 1, unit_amount_cents: 12000, weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 }] };
  const store = {
    shipmentForOrder: async () => stored, shipmentCreationContext: async () => context,
    claimShipmentCreation: async (_orderId, operationId) => operation ? { claimed: false, status: operation.status }
      : ((operation = { operationId, status: "in_progress" }), { claimed: true }),
    completeShipmentCreation: async () => { operation.status = "completed"; return true; },
    markShipmentCreationUncertain: async () => { operation.status = "needs_reconciliation"; return true; },
    saveShipment: async (orderId, value) => (stored = { order_id: orderId, ...value, tracking_code: value.trackingCode,
      label_url: null, track_url: null, provider_cost_cents: null, status: "label_created" }),
  };
  const enviaClient = { ready: true, generateLabel: async () => { providerCalls += 1; await providerGate;
    return { data: [{ shipmentId: "shipment-1", trackingNumber: "BR-RACE" }] }; } };
  const environment = { galaticShippingOrigin: { name: "Galatic", email: "loja@example.com", phone: "11999999999",
    street: "Rua A", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000", taxId: "11222333000181" } };
  const service = createGalaticFulfillmentService({ environment, store, enviaClient });
  const first = service.createLabel(context.id);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.createLabel(context.id), (error) => error.code === "shipping_in_progress");
  assert.equal(providerCalls, 1);
  releaseProvider();
  assert.equal((await first).created, true);
});

test("blocks blind retry when Envia result is uncertain", async () => {
  let operation = null; let calls = 0; const alerts = [];
  const store = { shipmentForOrder: async () => null, shipmentCreationContext: async () => ({ id: "order-uncertain", payment_status: "paid",
    buyer_name: "Cliente", buyer_email: "c@example.com", buyer_phone: "11999999999", buyer_document: "52998224725",
    service_code: "correios:pac", shipping_address: { street: "Rua", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" },
    items: [{ title: "Jogo", quantity: 1, unit_amount_cents: 1000, weight_grams: 1000, length_cm: 10, width_cm: 10, height_cm: 10 }] }),
    claimShipmentCreation: async (_id, operationId) => operation ? { claimed: false, status: operation.status }
      : ((operation = { operationId, status: "in_progress" }), { claimed: true }),
    markShipmentCreationUncertain: async () => { operation.status = "needs_reconciliation"; return true; },
    recordOperationalAlert: async (value) => alerts.push(value) };
  const enviaClient = { ready: true, generateLabel: async () => { calls += 1; throw Object.assign(new Error("timeout"), { code: "timeout" }); } };
  const environment = { galaticShippingOrigin: { name: "Galatic", street: "Rua", number: "1", district: "Centro", city: "Sao Paulo", state: "SP", postalCode: "01001000" } };
  const service = createGalaticFulfillmentService({ environment, store, enviaClient });
  await assert.rejects(() => service.createLabel("order-uncertain"), (error) => error.code === "timeout");
  await assert.rejects(() => service.createLabel("order-uncertain"), (error) => error.code === "shipping_needs_reconciliation");
  assert.equal(calls, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "shipment_reconciliation_required");
  assert.equal(alerts[0].context.orderId, "order-uncertain");
});

test("authenticates and deduplicates Envia tracking webhooks", async () => {
  const secret = "envia-webhook-secret"; const timestamp = String(Date.now()); const event = "tracking.simple";
  const body = { type: event, data: { tracking_number: "BR123", status: "delivered", status_description: "Entregue" } };
  const rawBody = JSON.stringify(body); const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${event}.${rawBody}`).digest("hex");
  const calls = []; const notifications = [];
  const handler = createEnviaWebhookHandler({ environment: { galaticEnviaWebhookSecret: secret },
    store: { updateShipmentFromEvent: async (value) => { calls.push(value); return { updated: true, orderId: "order-1" }; },
      getOrderNotification: async () => ({ orderId: "order-1", email: "cliente@example.com", name: "Cliente" }),
      claimNotification: async () => true, releaseNotification: async () => {} },
    notifications: { sendShippingUpdate: async (value) => { notifications.push(value); } } });
  const request = { body, rawBody, get: (name) => ({ "x-webhook-timestamp": timestamp, "x-webhook-event": event,
    "x-webhook-signature": `v1=${signature}`, "x-webhook-id": "delivery-1" })[name.toLowerCase()] };
  const response = { code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
  await handler(request, response);
  assert.equal(response.code, 200); assert.equal(calls.length, 1); assert.equal(calls[0].status, "delivered");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1); assert.equal(notifications[0].status, "delivered");
});
