import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { getEnvironment } from "../src/config/environment.js";
import { assertTenantIsolation, getTenantDefinitions } from "../src/config/tenants.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";

const source = {
  NODE_ENV: "production",
  PAYMENT_TENANTS: "academy4u,galatic",
  ACADEMY4U_PUBLIC_ORIGIN: "https://academy4u.com.br",
  ACADEMY4U_MYSQL_URL: "mysql://academy-db",
  ACADEMY4U_TRUSTED_CHECKOUT_TOKEN: "academy-secret",
  GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
  GALATIC_MYSQL_URL: "mysql://galatic-db",
  GALATIC_TRUSTED_CHECKOUT_TOKEN: "galatic-secret",
};

test("requires independent origins, references and databases for every payment tenant", () => {
  const environment = getEnvironment(source);
  const tenants = assertTenantIsolation(getTenantDefinitions(source, environment));
  assert.deepEqual(tenants.map((tenant) => ({
    id: tenant.id,
    origin: tenant.publicOrigin,
    database: tenant.mysqlUrl,
    reference: tenant.referencePrefix,
  })), [
    { id: "academy4u", origin: "https://academy4u.com.br", database: "mysql://academy-db", reference: "academy" },
    { id: "galatic", origin: "https://galatic.com.br", database: "mysql://galatic-db", reference: "galatic" },
  ]);

  assert.throws(
    () => assertTenantIsolation(getTenantDefinitions({ ...source, GALATIC_MYSQL_URL: "mysql://academy-db" }, environment)),
    /independent MySQL database/,
  );
  assert.throws(
    () => assertTenantIsolation(getTenantDefinitions({ ...source, GALATIC_PUBLIC_ORIGIN: "https://academy4u.com.br" }, environment)),
    /distinct public origin/,
  );
});

test("keeps tenant routes and browser origins isolated", async (context) => {
  const academyStore = createInMemoryStore();
  const galaticStore = createInMemoryStore();
  const runtime = createApp({
    ...source,
    NODE_ENV: "development",
    ACADEMY4U_MYSQL_URL: "",
    GALATIC_MYSQL_URL: "",
  }, {
    stores: { academy4u: academyStore, galatic: galaticStore },
  });
  await runtime.ready;
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([...runtime.stores.values()].map((store) => store.close()));
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const rejected = await fetch(`${base}/v1/platforms/academy4u/public/products`, {
    headers: { origin: "https://galatic.com.br" },
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error, "tenant_origin_mismatch");

  const accepted = await fetch(`${base}/v1/platforms/academy4u/public/products`, {
    headers: { origin: "https://academy4u.com.br" },
  });
  assert.equal(accepted.status, 200);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.platforms.academy4u.database, "ready");
  assert.equal(body.platforms.galatic.database, "ready");
});
