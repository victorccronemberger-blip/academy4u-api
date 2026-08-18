// ============================================================================
// ART CLIENT — ativação de matrículas na plataforma ART
// ----------------------------------------------------------------------------
// Porta Node do fluxo validado (2026-08-18) em F:\ART\activate.mjs:
//   1. provision  POST /v1/checkout/process/start  SEM token  -> 500 (normal)
//   2. login IDM  POST ms-idm/api/login                        -> token IDM
//   3. fase2      POST /v1/checkout/process/start  COM token IDM -> 500 (normal)
//                 cria UMA LEVA de orders DENIED (principal + bônus)
//   4. login PLAT POST /login {loggingTo:"app-aluno"}          -> token plataforma
//   5. perfil     GET  /v1/checkout/findStudent?email=         -> id_usuario
//   6. scan       GET  /v1/crud/orders/{id} (topo da tabela, SEM range fixo)
//   7. flip TODAS POST /v1/crud/orders/{id}  (cada order com payload do SEU curso)
//   8. verify     GET  /v1/services/aluno/findCoursesByStudent -> curso visível
// ----------------------------------------------------------------------------
// Regras de robustez (à prova de falhas):
//   - Timeouts curtos por request (AbortSignal) e retry em falha transitória.
//   - NUNCA lança para cima em falha de ativação: retorna { ok:false, reason }.
//   - ok:true SÓ quando o curso foi confirmado visível no findCoursesByStudent
//     (ou já estava ativo). Flipar sem confirmar propagação NÃO é sucesso.
//   - A conta do aluno NUNCA é usada com senha errada em loop: se o login
//     falhar após o provision, a plataforma trocou a senha — PARA e devolve
//     "existing_account_no_access" (o serviço cai para o LMS e agenda retry).
//   - Scan sem range fixo: o topo da tabela de orders é localizado por
//     galloping + busca binária a partir do último topo conhecido (cache em
//     memória), então o crescimento da tabela nunca quebra a varredura.
//   - Reuso máximo por tentativa: 1 login IDM + 1 login plataforma (o token da
//     checagem de visibilidade é reaproveitado) + 1 scan — nada de dobrar
//     logins/scans na mesma conta (excesso QUEBRA a conta).
//   - ip_usuario fictício sempre (TEST-NET), nunca o IP do servidor.
// ============================================================================
import { constants, publicEncrypt, randomBytes } from "node:crypto";

const FALLBACK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5+/4ltzmA6H7CaBsmaixUiFLq
5kr3ZqreOd80IECMXiFJ46TSf/T17MU3n40ZGIlS54UbkST0e6JEApKVgMh7tFjq
5aU78nKEKKx76oNUWrkHarh551Vpvc46O1MasP32PiucWXs8FqaEK3aZQc+pxOyD
qhbzzkjPjKAAKs6hDwIDAQAB
-----END PUBLIC KEY-----`;

const DEFAULT_TIMEOUT_MS = 8_000;
const FAKE_IP = "203.0.113.50";
const DEFAULT_SCAN_FLOOR = 3_180_000;

export function createArtClient(environment = {}) {
  const apiOrigin = environment.artApiOrigin || "https://api.academiarafaeltoro.com.br";
  const idmOrigin = environment.artIdmOrigin || "https://ms-idm.academiarafaeltoro.com.br";
  const publicKey = environment.artPublicKey || FALLBACK_PUBLIC_KEY;
  const fakeIp = environment.artFakeIp || FAKE_IP;
  const timeoutMs = Number(environment.artRequestTimeoutMs) || DEFAULT_TIMEOUT_MS;
  // Fail-closed: a integração só roda quando explicitamente habilitada.
  const enabled = environment.artEnabled === true;
  // Delays do fluxo (configuráveis para testes; defaults = valores validados).
  const provisionPollMs = Number(environment.artProvisionPollMs) || 4_000;
  const phase2WaitMs = Number(environment.artPhase2WaitMs) || 5_000;
  const loginPollMs = Number(environment.artLoginPollMs) || 3_000;
  const verifyWaitMs = Number(environment.artVerifyWaitMs) || 25_000;
  // Piso da varredura de orders (não é teto: o topo é descoberto dinamicamente).
  const scanFloor = Number(environment.artScanFloor) || DEFAULT_SCAN_FLOOR;
  // Cache do último topo conhecido da tabela de orders. Scans subsequentes
  // partem de 2000 ids abaixo dele — o custo por scan cai para poucos probes.
  let lastKnownTop = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function xApiKey() {
    return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from("@newCheckout", "utf8")).toString("base64");
  }

  function encryptCard(card) {
    const clean = { ...card };
    clean.card_number = String(card?.card_number ?? "").replace(/[-_. ]/g, "");
    clean.holder_document = String(card?.holder_document ?? "").replace(/[-_. ]/g, "");
    const chunks = JSON.stringify(clean).match(/.{1,100}/g) ?? [];
    return JSON.stringify(chunks.map((chunk) => publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(chunk)).toString("base64")));
  }

  async function request(url, options = {}, retries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < retries) await sleep(500 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async function idmLogin(email, password) {
    const response = await request(`${idmOrigin}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json().catch(() => ({}));
    const data = body?.response?.data;
    if (response.status === 200 && body?.response?.status === "SUCCESS" && data?.token) {
      return { token: data.token, userId: String(data.id ?? data.user_id ?? "") };
    }
    return null;
  }

  async function platLogin(email, password) {
    const response = await request(`${apiOrigin}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password, remember: false, loggingTo: "app-aluno" }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 200 && body?.token) {
      return { token: body.token, userId: String(body.id ?? "") };
    }
    return null;
  }

  function checkoutPayload({ email, cpf, fullName, curso, idTurma }) {
    return {
      curso,
      id_turma: idTurma,
      full_name: String(fullName || "Aluno").slice(0, 180),
      email,
      phone_number: "11999999999",
      birth_date: "1990-01-01",
      document_number: cpf,
      instituicao_financeira: "998",
      another_financial_instituition: "",
      city: "Sao Paulo",
      state: "SP",
      street: "Rua Test",
      number: "123",
      district: "Centro",
      post_code: "01000000",
      type: "free",
      expiry: "",
      cupom: "",
      card: encryptCard({
        type: "", brand: "", card_number: "", expiration_month: "", expiration_year: "",
        holder_document: "", holder_name: "", security_code: "",
      }),
      installments: 1,
      afiliado: "",
      complement: "",
      contract: true,
      contractPrivacity: true,
      promo_opt_in: false,
      detailsCupom: { valid: false, cashValue: 0, value: 0 },
      selectedModules: [],
      getnet_fingerprint: randomBytes(16).toString("hex"),
      ip_usuario: fakeIp,
    };
  }

  async function findStudent(email, token) {
    const response = await request(`${apiOrigin}/v1/checkout/findStudent?email=${encodeURIComponent(email)}`, {
      headers: { "x-api-key": xApiKey(), Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status !== 200) return null;
    const body = await response.json().catch(() => null);
    return body?.id_usuario ? { idUsuario: Number(body.id_usuario) } : null;
  }

  // GET de UMA order pelo id. null quando não existe/sem acesso/erro de rede.
  async function fetchOrder(orderId, token) {
    try {
      const response = await request(`${apiOrigin}/v1/crud/orders/${orderId}`, {
        headers: { "x-api-key": xApiKey(), Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (response.status !== 200) return null;
      const body = await response.json().catch(() => null);
      return body?.id_order ? body : null;
    } catch {
      return null;
    }
  }

  // Localiza o topo da tabela de orders SEM range fixo (a tabela cresce para
  // sempre; um teto hardcoded vira falso negativo silencioso — blacklist #5):
  //   1. galloping a partir do último topo conhecido (passo dobra até 8000);
  //   2. ao estourar (4 misses seguidos com passo grande), busca binária entre
  //      o último hit e o menor miss conhecido até a janela ficar <= 1000 ids;
  //   3. caminhada fina (passo 250) até 4 misses seguidos confirmarem o topo.
  // Retorna 0 se nada foi encontrado (tabela vazia, token inválido etc.) —
  // o chamador trata como "sem orders" e falha fechado (fallback LMS).
  async function probeOrdersTop(token) {
    let hi = 0;
    let lowestMiss = 0;
    let pos = Math.max(scanFloor, (lastKnownTop || scanFloor) - 2_000);
    let step = 250;
    let misses = 0;
    let probes = 0;
    const MAX_PROBES = 200;
    while (probes < MAX_PROBES) {
      probes += 1;
      if (await fetchOrder(pos, token)) {
        hi = pos;
        misses = 0;
        step = Math.min(step * 2, 8_000);
        pos += step;
        continue;
      }
      if (!lowestMiss || pos < lowestMiss) lowestMiss = pos;
      misses += 1;
      if (misses < 4) {
        pos += step;
        continue;
      }
      if (!hi) return 0;
      if (step <= 250) break; // topo confirmado em granularidade fina
      while (lowestMiss - hi > 1_000 && probes < MAX_PROBES) {
        probes += 1;
        const mid = hi + Math.floor((lowestMiss - hi) / 2);
        if (await fetchOrder(mid, token)) hi = mid;
        else lowestMiss = mid;
      }
      step = 250;
      pos = hi + step;
      misses = 0;
    }
    if (hi) lastKnownTop = Math.max(lastKnownTop, hi);
    return hi;
  }

  // Sonda o topo da tabela de orders e varre o trecho final procurando o perfil.
  async function scanOrders(profileId, token) {
    const hi = await probeOrdersTop(token);
    if (!hi) return [];
    const found = [];
    const start = Math.max(scanFloor, hi - 350);
    // A janela sobe 260 ids acima do topo medido: cobre a margem da sonda e
    // orders criadas por outros alunos entre a sonda e o nosso fase2.
    for (let batchStart = start; batchStart <= hi + 260; batchStart += 25) {
      const batch = await Promise.all(Array.from({ length: 25 }, (_, index) => batchStart + index).map((orderId) => fetchOrder(orderId, token)));
      for (const body of batch) if (body) found.push(body);
    }
    return found.filter((order) => String(order.id_usuario) === String(profileId));
  }

  // Busca direta (sem scan) das orders flipadas em tentativas anteriores.
  // No retry, evita depender da janela do scan para achar orders antigas —
  // e é o que permite pular o fase2 sem criar levas duplicadas.
  async function fetchKnownOrders(knownOrderIds, profileId, token) {
    const ids = [...new Set((Array.isArray(knownOrderIds) ? knownOrderIds : []).map(Number).filter(Number.isSafeInteger))].slice(0, 30);
    if (!ids.length) return [];
    const orders = await Promise.all(ids.map((id) => fetchOrder(id, token)));
    return orders.filter((order) => order && String(order.id_usuario) === String(profileId));
  }

  function mergeOrders(primary, extra) {
    const byId = new Map();
    for (const order of [...primary, ...extra]) byId.set(Number(order.id_order), order);
    return [...byId.values()];
  }

  /**
   * Verifica se um curso já está visível na conta (findCoursesByStudent).
   * Retorna true se o curso aparecer com is_visible !== false.
   * O token PLATAFORMA obtido aqui é devolvido para reaproveitamento.
   */
  async function isCourseVisible(email, password, curso) {
    const plat = await platLogin(email, password);
    if (!plat) return { visible: false, token: null };
    try {
      const response = await request(`${apiOrigin}/v1/services/aluno/findCoursesByStudent`, {
        headers: { "x-api-key": xApiKey(), Authorization: `Bearer ${plat.token}`, Accept: "application/json" },
      });
      const courses = await response.json().catch(() => []);
      if (!Array.isArray(courses)) return { visible: false, token: plat.token };
      const found = courses.find((course) => String(course.tag ?? "") === String(curso));
      return { visible: Boolean(found && found.is_visible !== false), token: plat.token };
    } catch {
      return { visible: false, token: plat.token };
    }
  }

  /**
   * Ativa um curso na conta ART do aluno.
   * Fluxo robusto para conta existente:
   *   1. login IDM com CPF (conta criada por nós e senha ainda = CPF -> reuso).
   *   2. Se login falha -> provision (cria conta nova OU retorna 400 se existe).
   *   3. Provision 400 + login falha -> conta existe com senha desconhecida
   *      (criada externamente ou senha trocada pela plataforma) -> reason
   *      "existing_account_no_access" para o serviço tratar (fallback LMS).
   *   4. Com login OK: verifica se o curso já está ativo e pula a criação.
   *   5. Senão: fase2 (checkout com token IDM) -> scan -> flip -> verify.
   *   ok:true exige o curso CONFIRMADO visível no findCoursesByStudent
   *   (blacklist #10: nunca declarar ativado sem verificar).
   * @param {object} input { email, cpf, fullName, curso, idCurso, idTurma,
   *   findOnly?, knownOrderIds? } — knownOrderIds: ids de orders flipadas em
   *   tentativas anteriores (busca direta por id, sem depender da janela do scan).
   * @returns {Promise<{ok:boolean, reason?:string, profileId?:number, activated?:boolean,
   *                    alreadyActive?:boolean, accountExisted?:boolean,
   *                    flippedOrders?:number[], visibleCourses?:string[], propagated?:boolean}>}
   */
  async function activateCourse({ email, cpf, fullName, curso, idCurso, idTurma, findOnly = false, knownOrderIds = [] }) {
    if (!enabled) return { ok: false, reason: "art_disabled" };
    const normalizedCpf = String(cpf ?? "").replace(/\D/g, "");
    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    if (!/^\d{11}$/.test(normalizedCpf)) return { ok: false, reason: "invalid_cpf" };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) return { ok: false, reason: "invalid_email" };
    if (!curso || !Number.isSafeInteger(idCurso) || !Number.isSafeInteger(idTurma)) {
      return { ok: false, reason: "invalid_mapping" };
    }

    const payload = checkoutPayload({ email: normalizedEmail, cpf: normalizedCpf, fullName, curso, idTurma });

    // 1. login IDM (reuso de conta existente com senha = CPF).
    let idm = await idmLogin(normalizedEmail, normalizedCpf);
    // Login funcionou de primeira = conta JÁ EXISTIA com senha = CPF (criada
    // por nós antes, ou senha revertida pela plataforma). Distingue do caso
    // "conta nova recém-provisionada" (login só passa após o provision+polling).
    const reusedExistingAccount = Boolean(idm);

    // 2. Se não logou, provisiona (conta nova). Conta já existente -> 400.
    let accountExisted = false;
    if (!idm) {
      try {
        const provision = await request(`${apiOrigin}/v1/checkout/process/start`, {
          method: "POST",
          headers: { "x-api-key": xApiKey(), "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
        if (provision.status === 400) {
          // Conta existe (o email já está registrado) mas não logamos com CPF.
          accountExisted = true;
        } else if (provision.status !== 500 && provision.status !== 200) {
          return { ok: false, reason: `provision_http_${provision.status}` };
        }
      } catch (error) {
        return { ok: false, reason: "provision_error", errorType: error?.name };
      }
      // polling do login (conta nova demora alguns segundos para existir).
      for (let i = 0; i < 30 && !idm; i++) {
        await sleep(provisionPollMs);
        idm = await idmLogin(normalizedEmail, normalizedCpf);
      }
    }

    // 3. Conta existe, mas não conseguimos autenticar (senha trocada pela
    //    plataforma ou conta criada externamente). Não insistimos (evita queimar
    //    a conta) — o serviço cai para o fallback LMS e registra para tratamento.
    if (!idm) {
      if (accountExisted) return { ok: false, reason: "existing_account_no_access", accountExisted: true };
      return { ok: false, reason: "idm_login_failed" };
    }

    // 4. Verifica se o curso já está ativo (evita duplicar ordens).
    //    O token PLATAFORMA desta chamada é reaproveitado no resto do fluxo
    //    (1 login a menos por tentativa — excesso de logins quebra a conta).
    const visibleCheck = await isCourseVisible(normalizedEmail, normalizedCpf, curso);
    if (visibleCheck.visible) {
      // findStudent exige token PLATAFORMA (token IDM aqui -> 401).
      const student = visibleCheck.token
        ? await findStudent(normalizedEmail, visibleCheck.token).catch(() => null)
        : null;
      return {
        ok: true,
        profileId: student?.idUsuario ?? null,
        alreadyActive: true,
        accountExisted,
        flippedOrders: [],
        visibleCourses: [curso],
        propagated: true,
      };
    }

    // 4b. Conta que JÁ EXISTIA (ex.: retry do worker): se já existem orders
    // não-APPROVED do curso (achadas pelo scan do topo ou pelos ids conhecidos
    // de tentativas anteriores), NÃO criar outra leva no fase2 (cada fase2
    // gera 7 orders novas; acumular levas suja a conta). O resultado deste
    // scan é REUTILIZADO no flip — nada de escanear a conta duas vezes.
    let platToken = visibleCheck.token ?? null;
    let student = null;
    let orders = null;
    let skipPhase2 = false;
    if (reusedExistingAccount && platToken) {
      student = await findStudent(normalizedEmail, platToken).catch(() => null);
      if (student) {
        const [scanned, known] = await Promise.all([
          scanOrders(student.idUsuario, platToken),
          fetchKnownOrders(knownOrderIds, student.idUsuario, platToken),
        ]);
        orders = mergeOrders(scanned, known);
        skipPhase2 = orders.some(
          (order) => String(order.curso ?? "") === String(curso) && String(order.status ?? "").toUpperCase() !== "APPROVED",
        );
      }
    }

    // 5. fase2 (checkout com token IDM) — cria a leva de orders DENIED.
    if (!skipPhase2) {
      try {
        const phase2 = await request(`${apiOrigin}/v1/checkout/process/start`, {
          method: "POST",
          headers: { "x-api-key": xApiKey(), Authorization: `Bearer ${idm.token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
        if (phase2.status !== 500 && phase2.status !== 200) {
          return { ok: false, reason: `phase2_http_${phase2.status}` };
        }
      } catch (error) {
        return { ok: false, reason: "phase2_error", errorType: error?.name };
      }
      // A leva nova nasce no topo da tabela: o scan anterior ficou obsoleto.
      orders = null;
      await sleep(phase2WaitMs);
    }

    // 6. token PLATAFORMA (reusa o da checagem de visibilidade quando há).
    if (!platToken) {
      for (let i = 0; i < 10 && !platToken; i++) {
        await sleep(loginPollMs);
        const login = await platLogin(normalizedEmail, normalizedCpf);
        platToken = login?.token ?? null;
      }
    }
    if (!platToken) return { ok: false, reason: "platform_login_failed" };

    // 7. perfil.
    if (!student) student = await findStudent(normalizedEmail, platToken);
    if (!student) return { ok: false, reason: "find_student_failed" };

    // 8. orders do perfil (scan do topo + ids conhecidos), se ainda não temos.
    if (!orders) {
      const [scanned, known] = await Promise.all([
        scanOrders(student.idUsuario, platToken),
        fetchKnownOrders(knownOrderIds, student.idUsuario, platToken),
      ]);
      orders = mergeOrders(scanned, known);
    }

    const isApproved = (order) => String(order.status ?? "").toUpperCase() === "APPROVED";
    const targetOrders = orders.filter((order) => String(order.curso ?? "") === String(curso));
    if (targetOrders.length && targetOrders.some(isApproved)) {
      return {
        ok: true,
        profileId: student.idUsuario,
        alreadyActive: true,
        accountExisted,
        flippedOrders: [],
        visibleCourses: [curso],
        propagated: true,
      };
    }
    if (findOnly) {
      return {
        ok: true,
        profileId: student.idUsuario,
        alreadyActive: targetOrders.some(isApproved),
        accountExisted,
        flippedOrders: [],
        visibleCourses: targetOrders.map((order) => String(order.curso ?? "")),
      };
    }

    // 9. flip de TODAS as orders não-APPROVED (cada uma com payload do SEU curso).
    const flippedOrders = [];
    const denied = orders.filter((order) => !isApproved(order));
    for (const order of denied) {
      const orderCurso = String(order.curso ?? "");
      const orderIdCurso = Number(order.id_curso) || idCurso;
      const orderTurma = Number(order.id_turma) || idTurma;
      const jsonRetorno = JSON.stringify({
        status: "APPROVED",
        free: {
          description: "",
          model: {
            id_usuario: Number(student.idUsuario),
            curso: orderCurso,
            id_curso: orderIdCurso,
            id_turma: orderTurma,
            parcelas: 1,
            afiliado: "",
            cupom: "",
            metodo_pagamento: "free",
            ip_usuario: fakeIp,
            promo_opt_in: false,
            promo_opt_in_at: null,
            id_order: Number(order.id_order),
            id_cart: order.id_cart ? Number(order.id_cart) : null,
            valor: 0,
            status: "APPROVED",
          },
        },
      });
      try {
        const flip = await request(`${apiOrigin}/v1/crud/orders/${order.id_order}`, {
          method: "POST",
          headers: { "x-api-key": xApiKey(), Authorization: `Bearer ${platToken}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            status: "APPROVED",
            valor: 0,
            metodo_pagamento: "free",
            id_turma: orderTurma,
            ip_usuario: fakeIp,
            json_retorno: jsonRetorno,
          }),
        });
        const text = await flip.text().catch(() => "");
        if (flip.status === 200 && String(text).trim() === "1") {
          flippedOrders.push(Number(order.id_order));
        } else {
          return { ok: false, reason: `flip_http_${flip.status}`, flippedOrders };
        }
      } catch (error) {
        return { ok: false, reason: "flip_error", errorType: error?.name, flippedOrders };
      }
      await sleep(800);
    }

    // 10. verificação — até ~2 min aguardando o curso ficar visível.
    let visible = false;
    for (let i = 0; i < 5 && !visible; i++) {
      await sleep(verifyWaitMs);
      try {
        const coursesResponse = await request(`${apiOrigin}/v1/services/aluno/findCoursesByStudent`, {
          headers: { "x-api-key": xApiKey(), Authorization: `Bearer ${platToken}`, Accept: "application/json" },
        });
        const courses = await coursesResponse.json().catch(() => []);
        if (Array.isArray(courses)) {
          const found = courses.find((course) => String(course.tag ?? "") === String(curso));
          visible = Boolean(found && found.is_visible !== false);
        }
      } catch {
        // tenta de novo na próxima iteração
      }
    }

    // Blacklist #10: NUNCA declarar ativado sem ver o curso no
    // findCoursesByStudent. O serviço trata como falha: LMS imediato + retry
    // agendado (numa próxima tentativa o curso pode já estar visível e o
    // fluxo encerra por alreadyActive).
    if (!visible) {
      return {
        ok: false,
        reason: flippedOrders.length ? "propagation_not_confirmed" : "orders_not_found",
        profileId: student.idUsuario,
        accountExisted,
        flippedOrders,
      };
    }

    return {
      ok: true,
      profileId: student.idUsuario,
      activated: flippedOrders.length > 0,
      alreadyActive: false,
      accountExisted,
      flippedOrders,
      visibleCourses: [curso],
      propagated: true,
    };
  }

  return Object.freeze({
    enabled,
    activateCourse,
    idmLogin,
    platLogin,
    findStudent,
    isCourseVisible,
  });
}
