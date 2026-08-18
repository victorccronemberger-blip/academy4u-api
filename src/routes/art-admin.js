// ============================================================================
// ART ADMIN ROUTES — gestão do mapeamento curso(LMS) -> curso(ART) e auditoria
// ----------------------------------------------------------------------------
// Rotas (somente servidor-a-servidor, header x-academy-trusted-token):
//   GET    /v1/platforms/:tenantId/art/mappings            listar mapeamentos
//   POST   /v1/platforms/:tenantId/art/mappings            criar/atualizar
//   DELETE /v1/platforms/:tenantId/art/mappings/:courseId  desativar
//   GET    /v1/platforms/:tenantId/art/activations         auditoria
// Compatibilidade no tenant default (academy4u):
//   GET/POST /v1/art/mappings · DELETE /v1/art/mappings/:courseId
//   GET /v1/art/activations
// ============================================================================
function createTrustedGuard(trustedCheckoutToken) {
  return function trusted(request, response, next) {
    const received = String(request.get("x-academy-trusted-token") ?? "");
    const expected = trustedCheckoutToken;
    if (!expected) {
      response.status(503).json({ error: "trusted_token_not_configured" });
      return;
    }
    if (received !== expected) {
      response.status(401).json({ error: "invalid_trusted_token" });
      return;
    }
    next();
  };
}

function normalizeMapping(input) {
  const courseId = Number(input?.courseId ?? input?.course_id);
  const artTag = String(input?.artTag ?? input?.art_tag ?? "").trim();
  const artIdCurso = Number(input?.artIdCurso ?? input?.art_id_curso);
  const artTurma = Number(input?.artTurma ?? input?.art_turma);
  const active = input?.active !== false && input?.active !== 0;
  if (!Number.isSafeInteger(courseId) || courseId < 1) throw new Error("invalid_art_course_id");
  if (!artTag) throw new Error("invalid_art_tag");
  if (!Number.isSafeInteger(artIdCurso) || artIdCurso < 1) throw new Error("invalid_art_id_curso");
  if (!Number.isSafeInteger(artTurma) || artTurma < 1) throw new Error("invalid_art_turma");
  return { courseId, artTag, artIdCurso, artTurma, active };
}

export function createArtAdminRouter(express, { environment, store, artRetryWorker = null }) {
  const router = express.Router();
  const trustedGuard = createTrustedGuard(environment.trustedCheckoutToken);

  router.use(trustedGuard);
  router.use((request, _response, next) => {
    request.artRetryWorker = artRetryWorker;
    next();
  });

  router.get("/mappings", async (_request, response) => {
    const rows = await store.listArtMappings();
    response.json({ mappings: rows });
  });

  router.post("/mappings", async (request, response) => {
    try {
      const mapping = normalizeMapping(request.body);
      const saved = await store.saveArtMapping(mapping);
      response.status(200).json({ mapping: saved });
    } catch (error) {
      response.status(400).json({ error: error?.message ?? "invalid_mapping" });
    }
  });

  router.delete("/mappings/:courseId", async (request, response) => {
    const courseId = Number(request.params.courseId);
    if (!Number.isSafeInteger(courseId) || courseId < 1) {
      response.status(400).json({ error: "invalid_art_course_id" });
      return;
    }
    await store.deleteArtMapping(courseId);
    response.json({ disabled: true });
  });

  router.get("/activations", async (request, response) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    // Limite casa com a coluna status VARCHAR(40) — truncar em 24 faria o
    // filtro por "existing_account_no_access" (26 chars) nunca casar.
    const status = typeof request.query.status === "string" && request.query.status ? String(request.query.status).slice(0, 40) : null;
    const rows = await store.listArtActivations({ limit, status });
    response.json({ activations: rows });
  });

  // Força a execução imediata do worker de retry (senha revertida / reprocessar
  // pendências). Sem body, processa a fila; com {activationId}, processa um item.
  router.post("/retry", async (request, response) => {
    if (typeof request.artRetryWorker?.processPending !== "function") {
      response.status(503).json({ error: "art_retry_worker_not_configured" });
      return;
    }
    try {
      const result = await request.artRetryWorker.processPending();
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: "art_retry_failed", message: error?.message ?? "unknown" });
    }
  });

  return router;
}
