import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeEnviaStatus } from "../services/galatic-fulfillment.js";

function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request, environment) {
  const secret = environment.galaticEnviaWebhookSecret;
  const token = environment.galaticEnviaWebhookToken;
  if (secret) {
    const timestamp = String(request.get("x-webhook-timestamp") ?? "");
    const event = String(request.get("x-webhook-event") ?? "");
    const signature = String(request.get("x-webhook-signature") ?? "").replace(/^v1=/, "");
    const milliseconds = Number(timestamp);
    if (!Number.isFinite(milliseconds) || Math.abs(Date.now() - milliseconds) > 5 * 60_000) return false;
    const expected = createHmac("sha256", secret).update(`${timestamp}.${event}.${request.rawBody ?? ""}`).digest("hex");
    return safeEqual(signature, expected);
  }
  if (token) return safeEqual(String(request.get("authorization") ?? ""), `Bearer ${token}`);
  return false;
}

export function createEnviaWebhookHandler({ environment, store }) {
  return async function enviaWebhook(request, response) {
    if (!authorized(request, environment)) return response.status(401).json({ error: "invalid_webhook_signature" });
    const data = request.body?.data ?? request.body;
    const trackingCode = String(data?.tracking_number ?? data?.trackingNumber ?? "").trim();
    const eventId = String(request.get("x-webhook-id") ?? request.body?.id ?? "").trim();
    const eventType = String(request.get("x-webhook-event") ?? request.body?.type ?? "tracking").trim();
    if (!eventId || !trackingCode) return response.status(400).json({ error: "invalid_webhook" });
    const result = await store.updateShipmentFromEvent({ eventId, eventType, trackingCode,
      status: normalizeEnviaStatus(data?.status ?? data?.shipment_status),
      description: String(data?.status_description ?? data?.description ?? data?.status ?? "").trim().slice(0, 500) });
    return response.json({ received: true, ...result });
  };
}
