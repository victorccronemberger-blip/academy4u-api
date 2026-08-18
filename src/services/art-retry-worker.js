// ============================================================================
// ART RETRY WORKER — converte ativações ART pendentes em segundo plano.
// ----------------------------------------------------------------------------
// Quando a ativação imediata falha por conta existente com senha desconhecida
// (a plataforma ART troca a senha e depois REVERTE para o CPF — padrão
// observado) ou por falha transitória, o worker re-tenta periodicamente:
//   - existing_account_no_access / failed / error, com retry_count < maxRetries
//   - backoff: 15min, 1h, 6h, 24h (dobra a cada tentativa)
// Quando consegue, marca status = activated (a matrícula ART passa a valer;
// o LMS criado como fallback continua como backup, sem ser removido).
// NUNCA insiste com senha errada em loop: cada retry é 1 login único com CPF.
// ============================================================================
export function createArtRetryWorker({ store, artClient, logger = console, maxRetries = 8 }) {
  let timer = null;
  let running = false;

  const backoffMs = (attempt) => {
    const minutes = [15, 60, 360, 1440];
    return minutes[Math.min(attempt, minutes.length - 1)] * 60_000;
  };

  async function processPending() {
    if (!artClient?.enabled) return { processed: 0 };
    if (running) return { processed: 0, busy: true };
    running = true;
    let processed = 0;
    try {
      const pending = await store.listArtActivationsPendingRetry({ limit: 20, maxRetries });
      for (const activation of pending) {
        try {
          // Re-avalia o mapping (pode ter sido desativado no meio tempo).
          const mapping = await store.getArtMapping(activation.courseId);
          if (!mapping || !mapping.active) {
            await store.updateArtActivationRetry(activation.id, { status: "mapping_disabled", retryCount: 99, nextRetryAt: null });
            continue;
          }
          const recipient = await store.getOrderRecipient(activation.orderId);
          if (!recipient) {
            await store.updateArtActivationRetry(activation.id, { status: "order_not_found", retryCount: 99, nextRetryAt: null });
            continue;
          }
          const outcome = await artClient.activateCourse({
            email: recipient.email,
            cpf: recipient.cpf,
            fullName: recipient.name,
            curso: mapping.artTag,
            idCurso: mapping.artIdCurso,
            idTurma: mapping.artTurma,
            // Orders flipadas em tentativas anteriores: o cliente busca por id
            // (sem scan) e pula o fase2 se ainda houver DENIED — evita criar
            // levas duplicadas quando as orders já saíram da janela do scan.
            knownOrderIds: Array.isArray(activation.flippedOrders) ? activation.flippedOrders : [],
          });
          const nextCount = Number(activation.retryCount ?? 0) + 1;
          if (outcome.ok) {
            await store.updateArtActivationRetry(activation.id, {
              status: "activated",
              retryCount: nextCount,
              nextRetryAt: null,
              result: outcome,
              flippedOrders: outcome.flippedOrders ?? null,
            });
            logger.log("ART retry activated.", { orderId: activation.orderId, courseId: activation.courseId, artTag: activation.artTag });
          } else {
            await store.updateArtActivationRetry(activation.id, {
              status: outcome.reason === "existing_account_no_access" ? "existing_account_no_access" : "failed",
              retryCount: nextCount,
              nextRetryAt: new Date(Date.now() + backoffMs(nextCount)).toISOString(),
              result: outcome,
              errorMessage: outcome.reason,
              flippedOrders: outcome.flippedOrders ?? null,
            });
            logger.log("ART retry still pending.", { orderId: activation.orderId, artTag: activation.artTag, reason: outcome.reason, attempt: nextCount });
          }
        } catch (error) {
          const nextCount = Number(activation.retryCount ?? 0) + 1;
          await store.updateArtActivationRetry(activation.id, {
            status: "error",
            retryCount: nextCount,
            nextRetryAt: new Date(Date.now() + backoffMs(nextCount)).toISOString(),
            errorMessage: `${error?.name}: ${error?.message ?? ""}`,
          });
          logger.error("ART retry error.", { orderId: activation.orderId, type: error?.name });
        }
        processed += 1;
      }
      return { processed };
    } finally {
      running = false;
    }
  }

  function start(intervalMs = 5 * 60_000) {
    if (timer) return;
    timer = setInterval(() => {
      processPending().catch((error) => logger.error("ART retry worker tick failed.", { type: error?.name }));
    }, intervalMs);
    timer.unref?.();
    logger.log("ART retry worker started.", { intervalMs });
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({
    processPending,
    start,
    stop,
  });
}
