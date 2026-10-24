import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const pausedBody = Object.freeze({ error: "financial_operations_paused", message: "Operações financeiras temporariamente pausadas." });

export function createGalaticFinancialGate({ enabled = false, metadata = {}, clock = () => new Date(), bootId = randomUUID() } = {}) {
  // Capture once. Neither later environment writes nor callers can open this gate.
  const allowed = enabled === true;
  const startedAt = clock().toISOString();
  const releaseRevision = metadata.releaseRevision ?? null;
  const sourceFingerprint = metadata.sourceFingerprint ?? null;
  let inFlight = 0;
  const assertEnabled = () => {
    if (!allowed) throw Object.assign(new Error(pausedBody.message), { code: pausedBody.error, status: 503 });
  };
  const diagnostics = () => ({ releaseRevision,
    sourceFingerprint, bootId, startedAt,
    galaticFinancialOperationsEnabled: allowed, galaticFinancialOperationsInFlight: inFlight });
  const run = async (work) => {
    assertEnabled();
    inFlight += 1;
    try { return await work(); } finally { inFlight -= 1; }
  };
  // Handlers retain auth and local-read ordering. Their explicit pause check
  // prevents work; only enabled asynchronous pipelines enter the counter.
  const track = (handler) => (...args) => allowed ? run(() => handler(...args)) : handler(...args);
  const middleware = (_request, response, next) => allowed ? next() : response.status(503).json(pausedBody);
  return Object.freeze({ enabled: allowed, assertEnabled, run, track, middleware, diagnostics,
    paused: (response) => response.status(503).json(pausedBody) });
}

export const closedGalaticFinancialGate = createGalaticFinancialGate();

export function financialRoute(router, gate, method, path, ...handlers) {
  return router[method](path, ...handlers.slice(0, -1), gate.track(handlers.at(-1)));
}

export function readGalaticBuildMetadata() {
  try {
    const value = JSON.parse(readFileSync(new URL("../../.build/runtime.json", import.meta.url), "utf8"));
    return { releaseRevision: /^[a-f0-9]{40}$/.test(value.releaseRevision) ? value.releaseRevision : null,
      sourceFingerprint: /^[a-f0-9]{64}$/.test(value.sourceFingerprint) ? value.sourceFingerprint : null };
  } catch { return { releaseRevision: null, sourceFingerprint: null }; }
}
