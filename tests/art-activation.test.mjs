import assert from "node:assert/strict";
import test from "node:test";
import { createArtClient } from "../src/integrations/art/client.js";
import { createArtActivationService } from "../src/services/art-activation.js";
import { createArtRetryWorker } from "../src/services/art-retry-worker.js";

// ---------------------------------------------------------------
// Mock de fetch: registra chamadas e devolve respostas programáveis.
// ---------------------------------------------------------------
function mockFetch(routes) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const entry = `${method} ${url}`;
    calls.push({ url: String(url), method, options });
    const matcher = routes.find((route) => {
      if (route.exact) return route.exact === entry;
      return route.prefix && entry.startsWith(route.prefix);
    });
    if (!matcher) return { status: 404, text: async () => "not found", json: async () => ({}) };
    const status = typeof matcher.status === "function" ? matcher.status(calls) : matcher.status;
    const body = typeof matcher.body === "function" ? matcher.body(calls) : matcher.body;
    return {
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
  };
  return {
    calls,
    restore() { globalThis.fetch = originalFetch; },
  };
}

const API = "https://api.academiarafaeltoro.com.br";
const IDM = "https://ms-idm.academiarafaeltoro.com.br";

const environment = {
  artEnabled: true,
  artApiOrigin: API,
  artIdmOrigin: IDM,
  artProvisionPollMs: 1,
  artPhase2WaitMs: 1,
  artLoginPollMs: 1,
  artVerifyWaitMs: 1,
};

function activationRoutes({ withOrders = true } = {}) {
  // Simula a tabela de orders densa da ART: ids 3191900..3192100 existem;
  // o perfil 5550001 tem as orders 3192001 (curso alvo) e 3192002 (bônus).
  // Login IDM: falha antes do provision (conta não existe) e passa depois.
  const profileOrders = withOrders
    ? [
        { id_order: 3192001, id_usuario: 5550001, status: "DENIED", curso: "cfp-2026_54", id_curso: 1738, id_turma: 4155 },
        { id_order: 3192002, id_usuario: 5550001, status: "DENIED", curso: "akim52", id_curso: 1401, id_turma: 4155 },
      ]
    : [];
  return [
    { prefix: `POST ${IDM}/api/login`, status: 200, body: (calls) => {
        const attempts = calls.filter((call) => call.url.includes("/api/login")).length;
        // 1ª chamada (antes do provision) -> falha; depois -> SUCCESS.
        return attempts === 1
          ? { response: { status: "ERROR", data: ["não encontradas"] } }
          : { response: { status: "SUCCESS", data: { id: 8880001, token: "idm-token" } } };
      } },
    { prefix: `POST ${API}/v1/checkout/process/start`, status: 500, body: { error: "Ops! Houve um erro inesperado" } },
    { prefix: `POST ${API}/login`, status: 200, body: { id: 8880001, profile_id: 5550001, token: "plat-token" } },
    { prefix: `GET ${API}/v1/checkout/findStudent?email=aluno%40exemplo.com`, status: 200, body: { id_usuario: 5550001, documento: "19100000000" } },
    { prefix: `GET ${API}/v1/crud/orders/`, status: (calls) => {
        const last = calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1);
        const id = Number(String(last?.url).split("/").pop());
        // Tabela densa e contígua como na ART real: ids 3180000..3192100 existem.
        return id >= 3180000 && id <= 3192100 ? 200 : 404;
      }, body: (calls) => {
        const last = calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1);
        const id = Number(String(last?.url).split("/").pop());
        const own = profileOrders.find((item) => item.id_order === id);
        if (own) return own;
        return { id_order: id, id_usuario: 1111111, status: "DENIED", curso: "outro-curso", id_curso: 1, id_turma: 1 };
      } },
    { prefix: `POST ${API}/v1/crud/orders/`, status: 200, body: "1", exact: null },
    { prefix: `GET ${API}/v1/services/aluno/findCoursesByStudent`, status: 200, body: (calls) => {
        const previous = calls.filter((call) => call.url.includes("findCoursesByStudent")).length;
        // 1ª chamada = checagem prévia (curso ainda não ativo); 2ª+ = pós-flip.
        return previous > 1 ? [{ tag: "cfp-2026_54", id_curso: 1738, is_visible: true }] : [];
      } },
  ];
}

test("ART client: ativa curso na conta do aluno (fluxo completo)", async (context) => {
  const mock = mockFetch(activationRoutes());
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "19100000000",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.profileId, 5550001);
  assert.ok(outcome.flippedOrders.length >= 1, "deve ter flipado orders");
  assert.equal(outcome.propagated, true);
  // valida que o provision e o fase2 foram chamados
  const provisions = mock.calls.filter((call) => call.url.endsWith("/v1/checkout/process/start"));
  assert.equal(provisions.length, 2, "provision + fase2");
  assert.equal(provisions[0].options.headers.Authorization, undefined, "provision sem token");
  assert.equal(provisions[1].options.headers.Authorization, "Bearer idm-token", "fase2 com token IDM");
  // o token PLATAFORMA da checagem de visibilidade é reutilizado no fluxo:
  // exatamente 1 login de plataforma por ativação (excesso de logins quebra a conta)
  const platLogins = mock.calls.filter((call) => call.url === `${API}/login`);
  assert.equal(platLogins.length, 1, "1 login plataforma reutilizado, sem login extra");
});

test("ART client: rejeita CPF inválido sem chamar a API", async (context) => {
  const mock = mockFetch(activationRoutes());
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "123",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "invalid_cpf");
  assert.equal(mock.calls.length, 0);
});

test("ART client: desabilitado retorna art_disabled", async (context) => {
  const mock = mockFetch(activationRoutes());
  context.after(mock.restore);
  const client = createArtClient({ artEnabled: false });
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "19100000000",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "art_disabled");
  assert.equal(mock.calls.length, 0);
});

test("ART client: falha de provision retorna reason sem lançar", async (context) => {
  const mock = mockFetch([
    { prefix: `POST ${API}/v1/checkout/process/start`, status: 429, body: { error: "rate" } },
  ]);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "19100000000",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /provision_http_429/);
});

test("ART client: reutiliza conta existente com senha CPF (login direto, sem provision)", async (context) => {
  // Mock sem provision: o login IDM já responde SUCCESS (conta existe com senha CPF).
  // A order 3192010 é do perfil, mas de OUTRO curso: não há DENIED do curso alvo,
  // então o fase2 roda normalmente (skipPhase2 não se aplica).
  const routes = [
    { prefix: `POST ${IDM}/api/login`, status: 200, body: { response: { status: "SUCCESS", data: { id: 8880002, token: "idm-token" } } } },
    { prefix: `POST ${API}/login`, status: 200, body: { id: 8880002, profile_id: 5550002, token: "plat-token" } },
    { prefix: `GET ${API}/v1/services/aluno/findCoursesByStudent`, status: 200, body: (calls) => {
        const previous = calls.filter((call) => call.url.includes("findCoursesByStudent")).length;
        return previous > 1 ? [{ tag: "cfp-2026_54", id_curso: 1738, is_visible: true }] : [];
      } },
    { prefix: `POST ${API}/v1/checkout/process/start`, status: 500, body: { error: "Ops!" } },
    { prefix: `GET ${API}/v1/checkout/findStudent?email=aluno%40exemplo.com`, status: 200, body: { id_usuario: 5550002 } },
    // Tabela densa e contígua como na ART real: ids 3180000..3192010 existem.
    { prefix: `GET ${API}/v1/crud/orders/`, status: (calls) => {
        const id = Number(String(calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1)?.url).split("/").pop());
        return id >= 3180000 && id <= 3192010 ? 200 : 404;
      }, body: (calls) => {
        const id = Number(String(calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1)?.url).split("/").pop());
        if (id === 3192010) return { id_order: 3192010, id_usuario: 5550002, status: "DENIED", curso: "outro-curso-antigo", id_curso: 1401, id_turma: 4155 };
        return { id_order: id, id_usuario: 1111111, status: "DENIED", curso: "outro-curso", id_curso: 1, id_turma: 1 };
      } },
    { prefix: `POST ${API}/v1/crud/orders/`, status: 200, body: "1" },
  ];
  const mock = mockFetch(routes);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "19100000000",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.accountExisted, false);
  const provisions = mock.calls.filter((call) => call.url.endsWith("/v1/checkout/process/start"));
  // conta existente com senha CPF -> provision NÃO é chamado (login direto)
  assert.equal(provisions.length, 1, "apenas o fase2, sem provision");
});

test("ART client: conta existe mas senha desconhecida -> existing_account_no_access", async (context) => {
  // Login IDM falha (senha != CPF) e o provision retorna 400 (conta existe).
  const routes = [
    { prefix: `POST ${IDM}/api/login`, status: 200, body: { response: { status: "ERROR", data: ["credenciais não encontradas"] } } },
    { prefix: `POST ${API}/v1/checkout/process/start`, status: 400, body: { error: ["já existe"] } },
  ];
  const mock = mockFetch(routes);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "19100000000",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "existing_account_no_access");
  assert.equal(outcome.accountExisted, true);
});

test("ART client: curso já ativo na conta existente -> alreadyActive sem criar ordem", async (context) => {
  // Login direto OK + findCoursesByStudent já mostra o curso.
  const routes = [
    { prefix: `POST ${IDM}/api/login`, status: 200, body: { response: { status: "SUCCESS", data: { id: 8880003, token: "idm-token" } } } },
    { prefix: `POST ${API}/login`, status: 200, body: { id: 8880003, profile_id: 5550003, token: "plat-token" } },
    { prefix: `GET ${API}/v1/services/aluno/findCoursesByStudent`, status: 200, body: [{ tag: "cfp-2026_54", id_curso: 1738, is_visible: true }] },
  ];
  const mock = mockFetch(routes);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "19100000000",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.alreadyActive, true);
  const checkouts = mock.calls.filter((call) => call.url.endsWith("/v1/checkout/process/start"));
  assert.equal(checkouts.length, 0, "curso já ativo -> nenhuma ordem criada");
});

// ---------------------------------------------------------------
// Serviço de orquestração (ART primeiro, LMS fallback)
// ---------------------------------------------------------------
function memoryStoreWithArt() {
  const store = {
    activations: [],
    alerts: [],
    async getOrderRecipient(orderId) {
      return {
        orderId,
        lmsRecipientUserId: 1001,
        email: "aluno@exemplo.com",
        cpf: "19100000000",
        name: "Aluno Teste",
      };
    },
    async getOrderItemsForArt(orderId) {
      return [
        { id: 1, courseId: 1738, courseSlug: "cfp-60-dias-exame-54", title: "CFP" },
        { id: 2, courseId: 999999, courseSlug: "curso-sem-art", title: "Sem ART" },
      ];
    },
    async getArtMapping(courseId) {
      if (courseId === 1738) return { courseId: 1738, artTag: "cfp-2026_54", artIdCurso: 1738, artTurma: 4155, active: true };
      return null;
    },
    async recordArtActivation(entry) { this.activations.push(entry); return { id: this.activations.length, status: entry.status }; },
    async recordOperationalAlert(alert) { this.alerts.push(alert); },
  };
  return store;
}

test("serviço ART: ativa item mapeado no ART e deixa sem-mapping para LMS", async (context) => {
  const mock = mockFetch(activationRoutes());
  context.after(mock.restore);
  const client = createArtClient(environment);
  const store = memoryStoreWithArt();
  const service = createArtActivationService({ environment, store, artClient: client });
  const outcome = await service.activateOrder("order-1");
  assert.equal(outcome.mode, "mixed");
  const artResult = outcome.results.find((result) => result.itemId === 1);
  const lmsResult = outcome.results.find((result) => result.itemId === 2);
  assert.equal(artResult.mode, "art");
  assert.equal(lmsResult.mode, "lms_fallback");
  assert.equal(lmsResult.reason, "no_art_mapping");
  const activation = store.activations.find((entry) => entry.courseId === 1738);
  assert.equal(activation.status, "activated");
  assert.equal(store.alerts.length, 0, "sem alerta quando ART ativa");
});

test("serviço ART: falha de ativação registra alerta e cai para LMS", async (context) => {
  const mock = mockFetch([
    { prefix: `POST ${API}/v1/checkout/process/start`, status: 429, body: { error: "rate" } },
  ]);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const store = memoryStoreWithArt();
  const service = createArtActivationService({ environment, store, artClient: client });
  const outcome = await service.activateOrder("order-2");
  const artResult = outcome.results.find((result) => result.itemId === 1);
  assert.equal(artResult.mode, "lms_fallback");
  assert.match(artResult.reason, /provision_http_429/);
  const activation = store.activations.find((entry) => entry.courseId === 1738);
  assert.equal(activation.status, "failed");
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].type, "art_activation_failed");
});

test("serviço ART: conta existente sem acesso registra alerta dedicado e cai para LMS", async (context) => {
  const mock = mockFetch([
    { prefix: `POST ${IDM}/api/login`, status: 200, body: { response: { status: "ERROR", data: ["não encontradas"] } } },
    { prefix: `POST ${API}/v1/checkout/process/start`, status: 400, body: { error: ["já existe"] } },
  ]);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const store = memoryStoreWithArt();
  const service = createArtActivationService({ environment, store, artClient: client });
  const outcome = await service.activateOrder("order-3");
  const artResult = outcome.results.find((result) => result.itemId === 1);
  assert.equal(artResult.mode, "lms_fallback");
  assert.equal(artResult.reason, "existing_account_no_access");
  const activation = store.activations.find((entry) => entry.courseId === 1738);
  assert.equal(activation.status, "existing_account_no_access");
  assert.ok(activation.nextRetryAt, "retry agendado para o worker");
  const alert = store.alerts.find((entry) => entry.type === "art_existing_account_no_access");
  assert.ok(alert, "alerta dedicado registrado");
});

test("ART client: conta existente com order DENIED antiga NÃO recria leva no fase2 (skipPhase2)", async (context) => {
  // Cenário do retry do worker: a conta já tem uma order DENIED do curso de uma
  // tentativa anterior. O cliente deve flipar a order existente SEM chamar o
  // checkout fase2 de novo (evita acumular levas de 7 orders na conta).
  const routes = [
    // login IDM com CPF funciona (senha revertida)
    { prefix: `POST ${IDM}/api/login`, status: 200, body: { response: { status: "SUCCESS", data: { id: 8880005, token: "idm-token" } } } },
    // findCoursesByStudent: curso ainda não visível
    { prefix: `POST ${API}/login`, status: 200, body: { id: 8880005, profile_id: 5550005, token: "plat-token" } },
    { prefix: `GET ${API}/v1/services/aluno/findCoursesByStudent`, status: 200, body: (calls) => {
        const previous = calls.filter((call) => call.url.includes("findCoursesByStudent")).length;
        // 1a chamada (isCourseVisible): vazio. Depois do flip: curso visível.
        return previous > 1 ? [{ tag: "cfp-2026_54", id_curso: 1738, is_visible: true }] : [];
      } },
    { prefix: `GET ${API}/v1/checkout/findStudent?email=aluno%40exemplo.com`, status: 200, body: { id_usuario: 5550005 } },
    // scan: tabela densa e contígua como na ART real (probe precisa de
    // id_order em todos os ids da faixa). Só a order 3192030 é do perfil alvo.
    { prefix: `GET ${API}/v1/crud/orders/`, status: (calls) => {
        const id = Number(String(calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1)?.url).split("/").pop());
        return id >= 3180000 && id <= 3192100 ? 200 : 404;
      }, body: (calls) => {
        const id = Number(String(calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1)?.url).split("/").pop());
        if (id === 3192030) return { id_order: 3192030, id_usuario: 5550005, status: "DENIED", curso: "cfp-2026_54", id_curso: 1738, id_turma: 4155 };
        return { id_order: id, id_usuario: 1111111, status: "DENIED", curso: "outro-curso", id_curso: 1, id_turma: 1 };
      } },
    { prefix: `POST ${API}/v1/crud/orders/`, status: 200, body: "1" },
  ];
  const mock = mockFetch(routes);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com", cpf: "19100000000", fullName: "Aluno Teste",
    curso: "cfp-2026_54", idCurso: 1738, idTurma: 4155,
  });
  const phase2Calls = mock.calls.filter((call) => call.url.includes("/v1/checkout/process/start"));
  assert.equal(phase2Calls.length, 0, "fase2 não deve ser chamado quando já existe order DENIED do curso");
  assert.equal(outcome.ok, true);
  assert.ok(outcome.flippedOrders.includes(3192030), "flip da order antiga");
});

test("worker ART: converte ativação pendente quando a senha reverte para CPF", async (context) => {
  // Store com uma ativação pendente (existing_account_no_access, retry vencido).
  const store = {
    ...memoryStoreWithArt(),
    pending: [{
      id: 1, orderId: "order-4", orderItemId: 1, courseId: 1738, lmsUserId: 1001,
      artEmail: "aluno@exemplo.com", artTag: "cfp-2026_54", status: "existing_account_no_access",
      retryCount: 1, nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    }],
    async listArtActivationsPendingRetry() { return this.pending; },
    async updateArtActivationRetry(activationId, update) {
      const activation = this.pending.find((entry) => entry.id === activationId);
      if (!activation) return false;
      Object.assign(activation, update);
      return true;
    },
    async getOrderRecipient() {
      return { orderId: "order-4", lmsRecipientUserId: 1001, email: "aluno@exemplo.com", cpf: "19100000000", name: "Aluno Teste" };
    },
    async getArtMapping(courseId) {
      return { courseId: 1738, artTag: "cfp-2026_54", artIdCurso: 1738, artTurma: 4155, active: true };
    },
  };
  // Agora o login com CPF FUNCIONA (senha reverteu) e o curso não está ativo ainda.
  const routes = [
    { prefix: `POST ${IDM}/api/login`, status: 200, body: { response: { status: "SUCCESS", data: { id: 8880004, token: "idm-token" } } } },
    { prefix: `POST ${API}/login`, status: 200, body: { id: 8880004, profile_id: 5550004, token: "plat-token" } },
    { prefix: `GET ${API}/v1/services/aluno/findCoursesByStudent`, status: 200, body: (calls) => {
        const previous = calls.filter((call) => call.url.includes("findCoursesByStudent")).length;
        return previous > 1 ? [{ tag: "cfp-2026_54", id_curso: 1738, is_visible: true }] : [];
      } },
    { prefix: `POST ${API}/v1/checkout/process/start`, status: 500, body: { error: "Ops!" } },
    { prefix: `GET ${API}/v1/checkout/findStudent?email=aluno%40exemplo.com`, status: 200, body: { id_usuario: 5550004 } },
    { prefix: `GET ${API}/v1/crud/orders/`, status: (calls) => {
        const id = Number(String(calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1)?.url).split("/").pop());
        // Tabela densa: o scan dinâmico encontra o topo (3192100) e a janela
        // final cobre a order 3192020 do perfil.
        return id >= 3180000 && id <= 3192100 ? 200 : 404;
      }, body: (calls) => {
        const id = Number(String(calls.filter((call) => call.url.includes("/v1/crud/orders/")).at(-1)?.url).split("/").pop());
        if (id === 3192020) return { id_order: 3192020, id_usuario: 5550004, status: "DENIED", curso: "cfp-2026_54", id_curso: 1738, id_turma: 4155 };
        return { id_order: id, id_usuario: 1111111, status: "DENIED", curso: "outro-curso", id_curso: 1, id_turma: 1 };
      } },
    { prefix: `POST ${API}/v1/crud/orders/`, status: 200, body: "1" },
  ];
  const mock = mockFetch(routes);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const worker = createArtRetryWorker({ store, artClient: client, logger: { log() {}, error() {} } });
  const result = await worker.processPending();
  assert.equal(result.processed, 1);
  assert.equal(store.pending[0].status, "activated");
  assert.equal(store.pending[0].nextRetryAt, null);
});

test("ART client: flip sem propagação NUNCA declara sucesso (blacklist #10)", async (context) => {
  // findCoursesByStudent SEMPRE vazio: o curso nunca fica visível. O cliente
  // precisa falhar fechado (propagation_not_confirmed) mesmo com flip ok —
  // declarar ativado aqui deixaria o aluno sem acesso no ART e sem LMS.
  const routes = activationRoutes();
  const coursesRoute = routes.find((route) => String(route.prefix).includes("findCoursesByStudent"));
  coursesRoute.body = [];
  const mock = mockFetch(routes);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const outcome = await client.activateCourse({
    email: "aluno@exemplo.com",
    cpf: "19100000000",
    fullName: "Aluno Teste",
    curso: "cfp-2026_54",
    idCurso: 1738,
    idTurma: 4155,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "propagation_not_confirmed");
  assert.ok(outcome.flippedOrders.length >= 1, "orders flipadas ficam registradas para o retry");
});

test("serviço ART: propagação não confirmada cai para LMS + alerta + retry elegível", async (context) => {
  const routes = activationRoutes();
  const coursesRoute = routes.find((route) => String(route.prefix).includes("findCoursesByStudent"));
  coursesRoute.body = [];
  const mock = mockFetch(routes);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const store = memoryStoreWithArt();
  const service = createArtActivationService({ environment, store, artClient: client });
  const outcome = await service.activateOrder("order-prop");
  const artResult = outcome.results.find((result) => result.itemId === 1);
  assert.equal(artResult.mode, "lms_fallback");
  assert.equal(artResult.reason, "propagation_not_confirmed");
  const activation = store.activations.find((entry) => entry.courseId === 1738);
  assert.equal(activation.status, "failed");
  assert.ok(activation.flippedOrders.length >= 1, "ids das orders salvos para o worker reutilizar");
  assert.ok(store.alerts.some((alert) => alert.type === "art_activation_failed"));
});

test("serviço ART: pedido sem itens cai para LMS (nunca vira modo art)", async (context) => {
  const mock = mockFetch(activationRoutes());
  context.after(mock.restore);
  const client = createArtClient(environment);
  const store = memoryStoreWithArt();
  store.getOrderItemsForArt = async () => [];
  const service = createArtActivationService({ environment, store, artClient: client });
  const outcome = await service.activateOrder("order-vazio");
  assert.equal(outcome.mode, "lms_fallback");
  assert.equal(outcome.reason, "no_order_items");
  assert.equal(mock.calls.length, 0, "nenhuma chamada à ART sem itens");
});

test("serviço ART: item já ativado (activated) não reexecuta o fluxo", async (context) => {
  const mock = mockFetch([]);
  context.after(mock.restore);
  const client = createArtClient(environment);
  const store = memoryStoreWithArt();
  store.getArtActivation = async (orderId, orderItemId) =>
    orderItemId === 1 ? { id: 9, status: "activated", artProfileId: 5550001 } : null;
  const service = createArtActivationService({ environment, store, artClient: client });
  const outcome = await service.activateOrder("order-duplicado");
  const artResult = outcome.results.find((result) => result.itemId === 1);
  assert.equal(artResult.mode, "art");
  assert.equal(artResult.reason, "already_recorded");
  assert.equal(mock.calls.length, 0, "nenhum login/scan na conta para item já ativado");
});

test("worker ART: reutiliza orders conhecidas (knownOrderIds) da tentativa anterior", async (context) => {
  const seen = [];
  const fakeClient = {
    enabled: true,
    async activateCourse(input) {
      seen.push(input);
      return { ok: true, alreadyActive: true, profileId: 5550004, flippedOrders: [] };
    },
  };
  const store = {
    ...memoryStoreWithArt(),
    pending: [{
      id: 7, orderId: "order-5", orderItemId: 1, courseId: 1738, lmsUserId: 1001,
      artEmail: "aluno@exemplo.com", artTag: "cfp-2026_54", status: "failed",
      retryCount: 1, nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      flippedOrders: [3192001, 3192002],
    }],
    async listArtActivationsPendingRetry() { return this.pending; },
    async updateArtActivationRetry(activationId, update) {
      Object.assign(this.pending.find((entry) => entry.id === activationId), update);
      return true;
    },
    async getArtMapping() {
      return { courseId: 1738, artTag: "cfp-2026_54", artIdCurso: 1738, artTurma: 4155, active: true };
    },
  };
  const worker = createArtRetryWorker({ store, artClient: fakeClient, logger: { log() {}, error() {} } });
  const result = await worker.processPending();
  assert.equal(result.processed, 1);
  assert.deepEqual(seen[0].knownOrderIds, [3192001, 3192002]);
  assert.equal(store.pending[0].status, "activated");
});

// ---------------------------------------------------------------
// Rotas admin ART (mappings + auditoria)
// ---------------------------------------------------------------
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";

const TRUSTED_TOKEN = "academy-trusted-checkout-token-2026";

function artEnabledEnvironment() {
  return {
    ASAAS_ENABLED: "false",
    TRUSTED_CHECKOUT_TOKEN: TRUSTED_TOKEN,
    ART_ENABLED: "true",
  };
}

async function serveApp(context, overrides = {}, dependencies = {}) {
  const { app } = createApp({
    PORT: "3199",
    PUBLIC_ORIGIN: "https://academy4u.com.br",
    ...artEnabledEnvironment(),
    ...overrides,
  }, dependencies);
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("rotas admin ART: gerencia mappings e registra ativações", async (context) => {
  const store = createInMemoryStore();
  const origin = await serveApp(context, {}, { store });
  const headers = { "x-academy-trusted-token": TRUSTED_TOKEN, "content-type": "application/json" };

  // criar mapping
  let response = await fetch(`${origin}/v1/art/mappings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ courseId: 1738, artTag: "cfp-2026_54", artIdCurso: 1738, artTurma: 4155 }),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.mapping.artTag, "cfp-2026_54");

  // listar
  response = await fetch(`${origin}/v1/art/mappings`, { headers });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.mappings.length, 1);

  // sem token -> 401
  response = await fetch(`${origin}/v1/art/mappings`);
  assert.equal(response.status, 401);

  // desativar
  response = await fetch(`${origin}/v1/art/mappings/1738`, { method: "DELETE", headers });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.disabled, true);

  // listar ativações (vazio)
  response = await fetch(`${origin}/v1/art/activations`, { headers });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(Array.isArray(body.activations), true);
});

test("rotas admin ART: filtro de status aceita status longos (26+ chars)", async (context) => {
  // Regressão do bug VARCHAR(24): "existing_account_no_access" tem 26 chars;
  // o filtro da rota não pode truncar o parâmetro abaixo de 40.
  const store = createInMemoryStore();
  await store.recordArtActivation({
    orderId: "order-status-longo",
    orderItemId: 1,
    courseId: 1738,
    lmsUserId: 1001,
    artEmail: "aluno@exemplo.com",
    artProfileId: null,
    artTag: "cfp-2026_54",
    status: "existing_account_no_access",
  });
  const origin = await serveApp(context, {}, { store });
  const headers = { "x-academy-trusted-token": TRUSTED_TOKEN };

  const response = await fetch(`${origin}/v1/art/activations?status=existing_account_no_access`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activations.length, 1);
  assert.equal(body.activations[0].status, "existing_account_no_access");
});
