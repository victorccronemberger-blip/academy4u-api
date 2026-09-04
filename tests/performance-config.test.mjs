import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../performance/config.mjs";

test("load harness defaults to ten local read-only users", () => {
  const config = loadConfig();
  assert.equal(config.origin, "http://127.0.0.1:3000");
  assert.equal(config.scenario.vus, 10);
  assert.equal(config.profile, "smoke");
});

test("load harness rejects remote origins, redirects in URL, credentials and invalid ports", () => {
  for (const origin of [
    "https://galatic.com.br", "https://api.academy4u.com.br", "http://10.0.0.1:3000",
    "http://localhost:3000@api.academy4u.com.br", "http://localhost.evil.test:3000",
    "http://localhost:3000/path", "http://localhost:3000?redirect=x",
    "http://localhost:3000\n", "http://localhost:65536", "http://localhost:0",
  ]) assert.throws(() => loadConfig({ LOAD_ORIGIN: origin }), undefined, origin);
});

test("capacity requires an explicit acknowledgement and holds 5000 users for 30 minutes", () => {
  assert.throws(() => loadConfig({ LOAD_PROFILE: "capacity" }));
  assert.throws(() => loadConfig({ LOAD_PROFILE: "unknown" }));
  const config = loadConfig({ LOAD_PROFILE: "capacity", CONFIRM_LOCAL_CAPACITY: "5000" });
  assert.ok(config.scenario.stages.some((s) => s.target === 5000 && s.duration === "30m"));
  assert.equal(config.scenario.stages.at(-1).target, 0);
});
