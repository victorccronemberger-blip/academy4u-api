import assert from "node:assert/strict";
import test from "node:test";

import { getEnvironment } from "../src/config/environment.js";

test("uses the canonical Hostinger environment names", () => {
  const environment = getEnvironment({
    PUBLIC_ORIGIN: "https://academy4u.com.br",
    MYSQL_URL: "mysql://canonical",
    TRUSTED_CHECKOUT_TOKEN: "canonical-token",
  });

  assert.equal(environment.publicOrigin, "https://academy4u.com.br");
  assert.equal(environment.mysqlUrl, "mysql://canonical");
  assert.equal(environment.trustedCheckoutToken, "canonical-token");
});

test("accepts the legacy Hostinger names without exposing or copying secrets", () => {
  const environment = getEnvironment({
    ACADEMY4U_ORIGIN: "https://academy4u.com.br",
    GALATIC_DATABASE_URL: "mysql://legacy",
    ACADEMY4U_TRUSTED_CHECKOUT_TOKEN: "legacy-token",
  });

  assert.equal(environment.publicOrigin, "https://academy4u.com.br");
  assert.equal(environment.mysqlUrl, "mysql://legacy");
  assert.equal(environment.trustedCheckoutToken, "legacy-token");
});

test("canonical names take precedence over legacy aliases", () => {
  const environment = getEnvironment({
    PUBLIC_ORIGIN: "https://canonical.example",
    ACADEMY4U_ORIGIN: "https://legacy.example",
    MYSQL_URL: "mysql://canonical",
    GALATIC_DATABASE_URL: "mysql://legacy",
    TRUSTED_CHECKOUT_TOKEN: "canonical-token",
    ACADEMY4U_TRUSTED_CHECKOUT_TOKEN: "legacy-token",
  });

  assert.equal(environment.publicOrigin, "https://canonical.example");
  assert.equal(environment.mysqlUrl, "mysql://canonical");
  assert.equal(environment.trustedCheckoutToken, "canonical-token");
});
