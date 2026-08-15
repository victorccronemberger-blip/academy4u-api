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
  let stored = null; const providerCalls = [];
  const store = {
    shipmentForOrder: async () => stored,
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
