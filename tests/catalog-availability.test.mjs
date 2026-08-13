import assert from "node:assert/strict";
import test from "node:test";
import { adminCatalog, replaceCatalogProducts } from "../src/domain/catalog.js";
import { CheckoutValidationError, createAuthoritativeQuote } from "../src/domain/quote.js";

test("keeps sold-out courses visible while excluding them from checkout", () => {
  replaceCatalogProducts([
    {
      slug: "curso-disponivel",
      sourceTag: "lms-course-1",
      title: "Curso disponível",
      priceCents: 49_900,
      active: true,
      availability: "available",
      purchasable: true,
    },
    {
      slug: "curso-esgotado",
      sourceTag: "lms-course-2",
      title: "Curso esgotado",
      priceCents: 59_900,
      active: true,
      availability: "sold_out",
      purchasable: false,
    },
  ]);

  assert.equal(adminCatalog.length, 2);
  assert.deepEqual(adminCatalog.find(({ slug }) => slug === "curso-esgotado"), {
    slug: "curso-esgotado",
    title: "Curso esgotado",
    categoryId: "outros",
    priceCents: 59_900,
    officialPriceCents: 59_900,
    cohort: null,
    sourceTag: "lms-course-2",
    availability: "sold_out",
    purchasable: false,
  });

  assert.throws(
    () => createAuthoritativeQuote({ slugs: ["curso-esgotado"] }),
    (error) => error instanceof CheckoutValidationError && error.code === "product_unavailable",
  );
  assert.equal(createAuthoritativeQuote({ slugs: ["curso-disponivel"] }).totalCents, 49_900);
});
