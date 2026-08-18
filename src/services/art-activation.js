// ============================================================================
// ART ACTIVATION SERVICE — orquestra a matrícula ART como principal,
// com fallback para o LMS (matrícula local) apenas quando o ART falha.
// ----------------------------------------------------------------------------
// Fluxo por item de pedido:
//   1. Se não há mapping ART para o course_id -> fallback LMS (comportamento atual).
//   2. Se há mapping: tenta ativar na conta ART do aluno (conta por aluno).
//      - Sucesso (curso visível ou já ativo) -> registra ativação, NÃO cria
//        matrícula LMS duplicada (a entrega principal é o ART).
//      - Falha em qualquer etapa -> registra falha + alerta operacional e
//        CAI para o LMS (grantOrderAccess), garantindo acesso ao aluno.
//   3. Idempotente: academy_art_activations deduplica por (order_id, order_item_id).
// ============================================================================
export function createArtActivationService({ environment, store, artClient }) {
  async function activateOrder(orderId) {
    const recipient = await store.getOrderRecipient(orderId);
    if (!recipient) return { mode: "lms_fallback", reason: "order_not_found" };
    const items = await store.getOrderItemsForArt(orderId);
    // Pedido sem itens NÃO pode virar mode "art": o caller pularia o
    // grantOrderAccess e o aluno ficaria sem acesso em qualquer plataforma.
    if (!items.length) return { orderId, mode: "lms_fallback", reason: "no_order_items", results: [] };
    const results = [];
    let anyLms = false;

    for (const item of items) {
      if (!item.courseId) {
        // Curso sem course_id mapeado: nada a fazer no ART, segue LMS.
        anyLms = true;
        results.push({ itemId: item.id, courseId: item.courseId, courseSlug: item.courseSlug, mode: "lms_fallback", reason: "no_course_id" });
        continue;
      }
      const mapping = await store.getArtMapping(item.courseId);
      if (!mapping) {
        anyLms = true;
        results.push({ itemId: item.id, courseId: item.courseId, courseSlug: item.courseSlug, mode: "lms_fallback", reason: "no_art_mapping" });
        continue;
      }

      const activation = await attemptActivation({
        orderId,
        item,
        recipient,
        mapping,
      });
      results.push(activation);
      if (activation.mode !== "art") anyLms = true;
    }

    // Se pelo menos um item caiu no LMS, o caller roda o grantOrderAccess, que
    // cria a matrícula LMS apenas dos itens NÃO ativados no ART (os ativados
    // são registrados como entrega sem enrollment, ver mysql-store).
    return { orderId, mode: anyLms ? "mixed" : "art", results };
  }

  async function attemptActivation({ orderId, item, recipient, mapping }) {
    // Idempotência: item já registrado como ativado no ART (ex.: webhook
    // re-entregue) não reexecuta o fluxo — cada execução custa logins/scans
    // na conta do aluno, e excesso de logins/scans QUEBRA a conta ART.
    if (typeof store.getArtActivation === "function") {
      const existing = await store.getArtActivation(orderId, item.id).catch(() => null);
      if (existing?.status === "activated") {
        return {
          itemId: item.id,
          courseId: item.courseId,
          courseSlug: item.courseSlug,
          mode: "art",
          artTag: mapping.artTag,
          reason: "already_recorded",
          profileId: existing.artProfileId ?? null,
          alreadyActive: true,
        };
      }
    }
    const log = async (status, extra = {}) => {
      try {
        await store.recordArtActivation({
          orderId,
          orderItemId: item.id,
          courseId: item.courseId,
          lmsUserId: recipient.lmsRecipientUserId ?? 0,
          artEmail: recipient.email,
          artProfileId: extra.profileId ?? null,
          artTag: mapping.artTag,
          status,
          result: extra.result ?? null,
          errorMessage: extra.errorMessage ?? null,
          flippedOrders: extra.flippedOrders ?? null,
          // null = preservar o valor já gravado (regravação pelo serviço não
          // pode zerar o contador/backoff do worker de retry).
          retryCount: extra.retryCount ?? null,
          nextRetryAt: extra.nextRetryAt ?? null,
        });
      } catch (error) {
        console.error("Could not record ART activation", { orderId, type: error?.name });
      }
    };

    try {
      const outcome = await artClient.activateCourse({
        email: recipient.email,
        cpf: recipient.cpf,
        fullName: recipient.name,
        curso: mapping.artTag,
        idCurso: mapping.artIdCurso,
        idTurma: mapping.artTurma,
      });

      if (outcome.ok) {
        await log("activated", {
          profileId: outcome.profileId,
          result: outcome,
          flippedOrders: outcome.flippedOrders,
        });
        return {
          itemId: item.id,
          courseId: item.courseId,
          courseSlug: item.courseSlug,
          mode: "art",
          artTag: mapping.artTag,
          profileId: outcome.profileId,
          alreadyActive: Boolean(outcome.alreadyActive),
          accountExisted: Boolean(outcome.accountExisted),
          flippedOrders: outcome.flippedOrders ?? [],
        };
      }

      // Conta ART do aluno já existe, mas não conseguimos autenticar com o CPF
      // (conta criada externamente ou senha trocada pela plataforma). Registra
      // com status dedicado + agendamento de retry (a plataforma reverte a
      // senha para o CPF) e cai para o LMS para não deixar o aluno sem acesso.
      if (outcome.reason === "existing_account_no_access") {
        const nextRetryAt = new Date(Date.now() + 15 * 60_000).toISOString();
        await log("existing_account_no_access", {
          errorMessage: "Conta ART já existe para este e-mail e a senha (CPF) não autentica. Retry agendado; LMS como cobertura imediata.",
          result: outcome,
          nextRetryAt,
        });
        await store.recordOperationalAlert?.({
          type: "art_existing_account_no_access",
          source: "art-activation",
          severity: "warning",
          summary: "Aluno já tem conta ART com senha desconhecida — retry agendado, LMS como cobertura.",
          context: { orderId, courseId: item.courseId, artTag: mapping.artTag, artEmail: recipient.email, nextRetryAt },
        });
        return {
          itemId: item.id,
          courseId: item.courseId,
          courseSlug: item.courseSlug,
          mode: "lms_fallback",
          reason: outcome.reason,
          artTag: mapping.artTag,
          artEmail: recipient.email,
        };
      }

      await log("failed", {
        errorMessage: outcome.reason,
        result: outcome,
        flippedOrders: outcome.flippedOrders,
      });
      await store.recordOperationalAlert?.({
        type: "art_activation_failed",
        source: "art-activation",
        severity: "warning",
        summary: `Ativação ART falhou (${outcome.reason}) — usando fallback LMS.`,
        context: { orderId, courseId: item.courseId, artTag: mapping.artTag, reason: outcome.reason },
      });
      return {
        itemId: item.id,
        courseId: item.courseId,
        courseSlug: item.courseSlug,
        mode: "lms_fallback",
        reason: outcome.reason,
        artTag: mapping.artTag,
      };
    } catch (error) {
      await log("error", { errorMessage: `${error?.name}: ${error?.message ?? ""}` });
      await store.recordOperationalAlert?.({
        type: "art_activation_error",
        source: "art-activation",
        severity: "warning",
        summary: "Erro inesperado na ativação ART — usando fallback LMS.",
        context: { orderId, courseId: item.courseId, artTag: mapping.artTag, errorType: error?.name },
      });
      return {
        itemId: item.id,
        courseId: item.courseId,
        courseSlug: item.courseSlug,
        mode: "lms_fallback",
        reason: `${error?.name ?? "Error"}: ${error?.message ?? ""}`,
        artTag: mapping.artTag,
      };
    }
  }

  return Object.freeze({
    activateOrder,
    isEnabled: () => Boolean(artClient?.enabled),
  });
}
