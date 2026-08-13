// Cria uma conta de serviço na ART (dados forjados) via provisionamento do
// checkout e valida a descoberta AUTORITATIVA de turmas (/v1/services/turmas
// com o RS256 da conta). Imprime as credenciais para ART_SERVICE_ACCOUNTS.
//
// Uso:
//   node scripts/setup-service-account.mjs [email] [cpf] [tag] [idTurma]
import { Agent } from "undici";
import { randomBytes } from "node:crypto";
import { generateXApiKey, encryptCard } from "../src/integrations/art/credentials.js";

const API = "https://api.academiarafaeltoro.com.br";
const IDM = "https://ms-idm.academiarafaeltoro.com.br";
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const f = (url, o = {}) => fetch(url, { ...o, dispatcher });
const xApiKey = generateXApiKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function genCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  let c1 = d.reduce((s, v, i) => s + (10 - i) * v, 0) % 11; c1 = c1 < 2 ? 0 : 11 - c1;
  const d2 = [...d, c1];
  let c2 = d2.reduce((s, v, i) => s + (11 - i) * v, 0) % 11; c2 = c2 < 2 ? 0 : 11 - c2;
  return [...d, c1, c2].join("");
}

const EMPTY_CARD = { type: "", brand: "", card_number: "", expiration_month: "", expiration_year: "", holder_document: "", holder_name: "", security_code: "" };

const email = process.argv[2] ?? `svc.turmas.academy.${Date.now().toString().slice(-8)}@gmail.com`;
const cpf = process.argv[3] ?? genCpf();
const tag = process.argv[4] ?? "10anos_anivertoro";   // curso vitalício (acesso permanente)
const idTurma = process.argv[5] ?? "4144";

console.log("=".repeat(70));
console.log("Criando conta de serviço na ART (dados forjados)");
console.log(`email=${email}\ncpf=${cpf}\ncurso=${tag}/${idTurma} (vitalício)`);
console.log("=".repeat(70));

const payload = {
  curso: tag, id_turma: Number(idTurma), full_name: "Servico Descoberta Turmas", email,
  phone_number: "11999999999", birth_date: "1990-01-01", document_number: cpf,
  instituicao_financeira: "998", another_financial_instituition: "",
  city: "Sao Paulo", state: "SP", street: "Rua Test", number: "123", district: "Centro", post_code: "01000000",
  type: "free", expiry: "", cupom: "", card: encryptCard(EMPTY_CARD), installments: 1,
  afiliado: "", complement: "", contract: true, contractPrivacity: true, promo_opt_in: false,
  detailsCupom: { valid: false, cashValue: 0, value: 0 }, selectedModules: [],
  getnet_fingerprint: randomBytes(16).toString("hex"),
};

// Fase 1: provisionamento (só x-api-key, sem Bearer)
const p1 = await f(`${API}/v1/checkout/process/start`, {
  method: "POST",
  headers: { "x-api-key": xApiKey, "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify(payload),
});
console.log(`\n[fase1] HTTP ${p1.status} (500 esperado — provisiona mesmo assim)`);

// Polling login (senha = CPF)
let token = null, userId = null;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline && !token) {
  await sleep(6000);
  const lr = await f(`${IDM}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: cpf }) });
  const body = await lr.json().catch(() => null);
  if (body?.response?.status === "SUCCESS") { token = body.response.data.token; userId = body.response.data.id; }
}
if (!token) { console.log("FALHOU: conta não provisionou em 180s"); process.exit(1); }
console.log(`[login] conta provisionada user_id=${userId} (login email+CPF ok, senha=CPF)`);

// Descoberta autoritativa: /v1/services/turmas com o RS256 da conta de serviço
let page = 1; const allTurmas = [];
while (page <= 100) {
  const tr = await f(`${API}/v1/services/turmas?page=${page}`, { headers: { "x-api-key": xApiKey, Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = await tr.json().catch(() => null);
  if (tr.status !== 200 || !Array.isArray(body?.data)) { console.log(`[turmas] page ${page} HTTP ${tr.status}`); break; }
  allTurmas.push(...body.data);
  if (page >= Number(body.last_page ?? page)) break;
  page += 1;
}
console.log(`\n[descoberta] /v1/services/turmas listou ${allTurmas.length} turmas (autoritativo, via RS256)`);
for (const t of ["cpa2026", "cproi2026", "cfp-2026_54", "ancord-2026", "iamf", "10anos_anivertoro"]) {
  const ativas = allTurmas.filter((x) => x.ativa === 1 && String(x.tag_curso ?? "") === t).sort((a, b) => Number(b.id_turma) - Number(a.id_turma));
  console.log(`  ${t.padEnd(20)} ativas: ${ativas.map((x) => x.id_turma).join(", ") || "nenhuma"}`);
}

console.log("\n" + "=".repeat(70));
console.log("CREDENCIAIS DA CONTA DE SERVIÇO (configure no ambiente de produção):");
console.log(`ART_SERVICE_ACCOUNTS=${email}:${cpf}`);
console.log("=".repeat(70));
