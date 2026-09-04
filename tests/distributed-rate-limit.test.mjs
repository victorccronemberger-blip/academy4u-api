import test from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowLimiter } from "../src/http/fixed-window-limiter.js";

function response() {
  return { code: 200, headers: {}, body: null,
    set(name, value) { if (typeof name === "object") Object.assign(this.headers, name); else this.headers[name] = value; return this; },
    status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
}

test("two limiter instances share one external counter without persisting the IP address", async () => {
  const counters = new Map(); const received = [];
  const consume = async ({ scope, keyHash, windowMs, nowMs }) => {
    received.push({ scope, keyHash });
    const id = `${scope}:${keyHash}`; const current = counters.get(id);
    const state = !current || current.resetAt <= nowMs ? { count: 0, resetAt: nowMs + windowMs } : current;
    state.count += 1; counters.set(id, state); return state;
  };
  const one = createFixedWindowLimiter({ limit: 2, now: () => 1000, prefix: "login", consume });
  const two = createFixedWindowLimiter({ limit: 2, now: () => 1000, prefix: "login", consume });
  const request = { ip: "203.0.113.42" };
  for (const limiter of [one, two]) {
    const reply = response(); let continued = false;
    await limiter(request, reply, () => { continued = true; });
    assert.equal(continued, true); assert.equal(reply.code, 200);
  }
  const blocked = response();
  await one(request, blocked, () => assert.fail("third request must be blocked"));
  assert.equal(blocked.code, 429);
  assert.equal(blocked.body.error, "rate_limited");
  assert.ok(received.every(({ scope, keyHash }) => scope === "login" && /^[a-f0-9]{64}$/.test(keyHash)));
  assert.ok(received.every(({ keyHash }) => !keyHash.includes(request.ip)));
});

test("external limiter fails closed when its store is unavailable", async () => {
  const limiter = createFixedWindowLimiter({ consume: async () => { throw new Error("database unavailable"); } });
  const reply = response(); let forwarded;
  await limiter({ ip: "127.0.0.1" }, reply, (error) => { forwarded = error; });
  assert.equal(forwarded?.message, "database unavailable");
});
