import { createGalaticDeferredEventReconciliation } from "../services/galatic-payment-events.js";
import { closedGalaticFinancialGate } from "../services/galatic-financial-gate.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { normalizeAsaasWebhookStatus } from "../domain/payment-status.js";
import { normalizeProviderInstallment } from "../services/installment-service.js";

function safeEqual(received, expected) {
  const left = Buffer.from(String(received ?? ""), "utf8");
  const right = Buffer.from(String(expected ?? ""), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeHashEqual(received, expectedHash) {
  const digest = createHash("sha256").update(String(received ?? ""), "utf8").digest("hex");
  return safeEqual(digest, expectedHash);
}

function paymentId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{6,80}$/.test(id) ? id : null;
}

export function createAsaasWebhookHandler({
  environment,
  store,
  onAccessGranted,
  onAccessRevoked,
  referencePrefix = "academy",
  paymentProfiles = null,
  legacyGalaticAuthentication = null,
  financialGate = closedGalaticFinancialGate,
}) {
  const isGalatic = environment.tenantId === "galatic" || referencePrefix === "galatic";
  const reconcileDeferred = isGalatic ? createGalaticDeferredEventReconciliation({ store, paymentProfiles, financialGate }) : null;
  const handler = async function asaasWebhook(request, response) {
    let profileId = null;
    if (isGalatic && paymentProfiles) {
      try { profileId = paymentProfiles.authenticateProfileWebhook(request.params.profileId, request.get("asaas-access-token")).profileId; }
      catch (error) { return response.status(error.status ?? 503).json({ error: error.code ?? "payment_profile_unavailable" }); }
      if (!financialGate.enabled) return financialGate.paused(response);
      try { await paymentProfiles.getVerifiedClient({ profileId }, "webhook"); }
      catch (error) { return response.status(503).json({ error: error.code }); }
    } else {
      const auth = isGalatic ? legacyGalaticAuthentication : environment;
      if (!auth?.asaasWebhookToken && !auth?.asaasWebhookTokenHash) return response.status(503).json({ error: "webhook_not_configured" });
      const authenticated = auth.asaasWebhookTokenHash
        ? safeHashEqual(request.get("asaas-access-token"), auth.asaasWebhookTokenHash)
        : safeEqual(request.get("asaas-access-token"), auth.asaasWebhookToken);
      if (!authenticated) return response.status(401).json({ error: "invalid_webhook_token" });
      if (isGalatic) return response.status(503).json({ error: "payment_profile_route_required" });
    }

    const event = String(request.body?.event ?? "").trim().toUpperCase();
    const eventId = String(request.body?.id ?? "").trim();
    const payment = request.body?.payment;
    const orderId = paymentId(payment?.id);
    const providerGroupId = paymentId(payment?.installment);
    const externalReference = String(payment?.externalReference ?? "").trim();
    if (
      !/^PAYMENT_[A-Z_]+$/.test(event)
      || !/^[A-Za-z0-9_&.-]{6,128}$/.test(eventId)
      || !orderId
      || !externalReference.startsWith(`${referencePrefix}:`)
    ) {
      response.status(400).json({ error: "invalid_webhook" });
      return;
    }

    try {
      let persisted;
      let accessGrantedNow = false;
      if (isGalatic) {
        persisted = await store.ingestAuthenticatedEvent({ profileId, event: { provider: "asaas", providerOrderId: orderId,
          providerGroupId, eventId, externalReference, status: normalizeAsaasWebhookStatus(event, payment?.status),
          paymentEvidence: { status: payment.status, deleted: payment.deleted, refundedValue: payment.refundedValue, refunds: payment.refunds, id: payment.id, customer: payment.customer, billingType: payment.billingType, value: payment.value,
            installment: payment.installment, externalReference } } });
      } else if (providerGroupId) {
        const installment = normalizeProviderInstallment(payment);
        if (!installment) {
          response.status(400).json({ error: "invalid_installment_webhook" });
          return;
        }
        installment.status = normalizeAsaasWebhookStatus(event, payment?.status);
        persisted = await store.updatePaymentInstallmentFromWebhook({
          profileId, provider: "asaas",
          providerOrderId: orderId,
          providerGroupId,
          installment,
          eventId,
          externalReference,
          paymentEvidence: { status: payment.status, deleted: payment.deleted, refundedValue: payment.refundedValue, refunds: payment.refunds, id: payment.id, customer: payment.customer, billingType: payment.billingType, value: payment.value, installment: payment.installment, externalReference },
        });
        accessGrantedNow = persisted?.accessGrantedNow === true;
      } else {
        persisted = await store.updateOrderFromWebhook({
          profileId, provider: "asaas",
          providerOrderId: orderId,
          providerGroupId: null,
          status: normalizeAsaasWebhookStatus(event, payment?.status),
          eventId,
          externalReference,
          paymentEvidence: { status: payment.status, deleted: payment.deleted, refundedValue: payment.refundedValue, refunds: payment.refunds, id: payment.id, customer: payment.customer, billingType: payment.billingType, value: payment.value, installment: payment.installment, externalReference },
        });
        accessGrantedNow = persisted?.status === "paid" && persisted?.previousStatus !== "paid";
      }
      if (isGalatic && persisted?.externalReference?.startsWith(`${referencePrefix}:`)) {
        const reconciled = await reconcileDeferred({ profileId, orderId: persisted.externalReference.slice(referencePrefix.length + 1) });
        if (reconciled.lastApplied) {
          persisted = reconciled.lastApplied;
          accessGrantedNow = persisted.status === "paid" && persisted.previousStatus !== "paid";
        }
      }
      if (accessGrantedNow && persisted?.id && onAccessGranted) {
        // A entrega (ativação ART + fallback LMS) pode levar MINUTOS (provision,
        // scan de orders, verificação de propagação). O Asaas espera resposta
        // rápida e o servidor tem requestTimeout de 75s: confirmamos o
        // recebimento imediatamente e processamos em background. O dedupe por
        // eventId/status + o lock por orderId em onAccessGranted impedem
        // reprocessamento e execução concorrente do mesmo pedido.
        const delivery = Promise.resolve()
          .then(() => onAccessGranted(persisted.id))
          .catch(async (error) => {
            console.error("Access grant pipeline failed after webhook ack", {
              orderId: persisted.id,
              type: error?.name,
            });
            try {
              await store.recordOperationalAlert?.({
                type: "access_grant_failed",
                source: "asaas-webhook",
                severity: "critical",
                summary: "Falha no pipeline de entrega (ART/LMS) após webhook confirmado.",
                context: { orderId: persisted.id, errorType: error?.name ?? "Error" },
              });
            } catch (alertError) {
              console.error("Could not persist operational alert", { type: alertError?.name });
            }
          });
        if (isGalatic) await delivery;
      }
      if (
        persisted?.id
        && ["refunded", "chargeback"].includes(persisted.status)
        && !["refunded", "chargeback"].includes(persisted.previousStatus)
        && onAccessRevoked
      ) {
        await onAccessRevoked(persisted.id, persisted.status);
      }
      response.status(200).json({ received: true, duplicate: Boolean(persisted?.duplicate) });
    } catch (error) {
      console.error("Could not persist Asaas webhook", {
        event,
        orderId,
        type: error?.name,
      });
      try {
        await store.recordOperationalAlert?.({
          type: "webhook_failure",
          source: "asaas-webhook",
          summary: "Falha ao processar webhook autenticado do Asaas.",
          context: { event, orderId, errorType: error?.name ?? "Error" },
        });
      } catch (alertError) {
        console.error("Could not persist operational alert", { type: alertError?.name });
      }
      response.status(500).json({ error: "webhook_processing_failed" });
    }
  };
  return isGalatic ? financialGate.track(handler) : handler;
}
