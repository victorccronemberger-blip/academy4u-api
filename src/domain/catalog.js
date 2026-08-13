import developmentCatalogSeed from "./catalog-data.json" with { type: "json" };

// Em produção, `courses` do LMS é a fonte de verdade. Esta fotografia em memória
// evita I/O dentro da transação e exclui cursos esgotados do checkout legado.
let productsBySlug = new Map();
let sourceTagBySlug = new Map();
let cohortBySlug = new Map();
let cohortBySourceTag = new Map();

export let checkoutCatalog = Object.freeze({});
export let adminCatalog = Object.freeze([]);

function normalize(product) {
  const slug = String(product?.slug ?? "").trim();
  const title = String(product?.title ?? "").trim();
  const sourceTag = String(product?.sourceTag ?? "").trim();
  const priceCents = Number(product?.priceCents);
  if (!/^[a-z0-9][a-z0-9-]{1,78}$/.test(slug) || !title || !sourceTag || !Number.isSafeInteger(priceCents) || priceCents < 0) throw new Error("Produto de catálogo inválido.");
  return Object.freeze({
    ...product, slug, title, sourceTag, priceCents,
    description: String(product.description ?? ""), categoryId: String(product.categoryId ?? "outros"), kind: String(product.kind ?? "course"),
    cohort: product.cohort === null || product.cohort === undefined || product.cohort === "" ? null : String(product.cohort),
    officialPriceCents: Number.isSafeInteger(Number(product.officialPriceCents)) ? Number(product.officialPriceCents) : priceCents,
    featured: Boolean(product.featured), active: product.active !== false,
    availability: product.availability === "sold_out" ? "sold_out" : "available",
    purchasable: product.purchasable !== false && product.availability !== "sold_out",
    keywords: Array.isArray(product.keywords) ? product.keywords.map(String) : [],
  });
}

export function replaceCatalogProducts(products) {
  const rows = (Array.isArray(products) ? products : []).filter((product) => product.active !== false).map(normalize);
  if (!rows.length) throw new Error("O catálogo de produtos está vazio.");
  if (new Set(rows.map((product) => product.slug)).size !== rows.length) throw new Error("O catálogo contém slugs duplicados.");
  productsBySlug = new Map(rows.map((product) => [product.slug, product]));
  sourceTagBySlug = new Map(rows.map((product) => [product.slug, product.sourceTag]));
  cohortBySlug = new Map(rows.filter((product) => product.cohort).map((product) => [product.slug, product.cohort]));
  cohortBySourceTag = new Map(rows.filter((product) => product.cohort).map((product) => [product.sourceTag, product.cohort]));
  checkoutCatalog = Object.freeze(Object.fromEntries(rows
    .filter((product) => product.purchasable)
    .map((product) => [product.slug, Object.freeze({ slug: product.slug, title: product.title, description: product.description, priceCents: product.priceCents })])));
  adminCatalog = Object.freeze(rows.map((product) => Object.freeze({ slug: product.slug, title: product.title, categoryId: product.categoryId, priceCents: product.priceCents, officialPriceCents: product.officialPriceCents, cohort: product.cohort, sourceTag: product.sourceTag, availability: product.availability, purchasable: product.purchasable })));
  return adminCatalog;
}

export function getCheckoutProduct(slug) { return checkoutCatalog[slug] ?? null; }
export function getSourceTag(slug) { return sourceTagBySlug.get(slug) ?? null; }
export function getCohort(slug) { return cohortBySlug.get(slug) ?? null; }
export function getCohortBySourceTag(sourceTag) { return cohortBySourceTag.get(sourceTag) ?? null; }

// Self-healing de cohort em memória (2026-08-01): o motor ART descobre a turma
// viva ao ativar; quando ela diverge do cohort gravado, atualiza o catálogo em
// memória + o banco (via store.updateProductCohortBySourceTag) para o cohort
// nunca ficar stale entre reboots.
export function syncCohortBySourceTag(sourceTag, cohort) {
  const value = String(cohort ?? "").trim();
  if (!value || !sourceTag) return;
  cohortBySourceTag.set(sourceTag, value);
  for (const [slug, tag] of sourceTagBySlug) {
    if (tag === sourceTag) cohortBySlug.set(slug, value);
  }
}

// Turmas de COMBO/derivadas por sourceTag (VETOR E da pesquisa Metodos-Toro
// 2026-08-01). O app do aluno (findCoursesByStudent) só lista o curso quando o
// id_turma da order pertence ao catálogo vigente — e para alguns cursos a turma
// que o APP aceita é a do produto combo, NÃO a do prepare do curso solo.
// Caso real: cfa_2025 — prepare devolve 3235 (invisível), o combo devolve 4134
// (visível). Estes são apenas HINTS adicionais; o flip tenta cada um e valida
// por polling.
const COMBO_TURMAS_BY_SOURCE_TAG = Object.freeze({
  cfa_2025: ["4134"],        // combo cfa-combol1l2l3
  "cfp-2026_54": [],         // sem combo conhecido — vazio é seguro
});

export function getComboTurmas(sourceTag) {
  const value = COMBO_TURMAS_BY_SOURCE_TAG[sourceTag];
  return value ? value.map(String) : [];
}

// Mantém testes unitários e o modo local utilizáveis. Em produção a fotografia é
// substituída obrigatoriamente pelos cursos reais do LMS antes de aceitar tráfego.
replaceCatalogProducts(developmentCatalogSeed);
