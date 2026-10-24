import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./helpers/payment-profiles.mjs";
import { createAsaasClient } from "../src/integrations/asaas/client.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";

const providerOrderId = "pay_synthetic_read";
const source = { GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", PAYMENT_TENANTS: "academy4u,galatic", ASAAS_ENABLED: "true", ASAAS_ENVIRONMENT: "sandbox",
  ASAAS_SANDBOX: "synthetic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br", ACADEMY4U_PUBLIC_ORIGIN: "https://academy4u.com.br" };
const qr = { encodedImage: "aW1hZ2U=", payload: "SYNTHETIC-QR", expirationDate: "2030-01-01" };

async function fixture(t, { initial = "open", payment = { id: providerOrderId, status: "PENDING" }, contract = "galatic-mysql",
  provider404 = false, updateFailure = false, rejectUpdate = false, onPayment = null, onQr = null, onCancel = null, method = "pix" } = {}) {
  const backing = createInMemoryStore();
  const seeded = await backing.createOrder({ provider: "asaas", providerOrderId, status: initial, paymentMethod: method,
    subtotalCents: 10000, discountCents: 0, totalCents: 10000, lines: [] });
  let current = { profileId: "galatic-synthetic", installments: 1, id: seeded.id, providerOrderId, status: initial, method, fulfillmentStatus: "awaiting_payment", totalCents: 10000 };
  const calls = [], transitions = [];
  let stockReleases = 0;
  const store = { ...backing, getCheckoutRecovery: async () => ({ profileId: current.profileId, state: "completed",
      order: { ...current }, providerCustomerId: "cus_profile_fixture", pricing: { totalCents: 10000 } }), getOrderByPublicId: async (id) => id === current.id && !current.removed ? { ...current } : null,
    updateOrderFromWebhook: async (input) => {
      transitions.push(input);
      if (updateFailure) throw new Error("synthetic_store_failure");
      if (rejectUpdate) return { id: null, deferred: true, status: input.status };
      if (contract === "in-memory") {
        const result = await backing.updateOrderFromWebhook(input);
        current.status = result.status;
        return result;
      }
      // Production MySQL contract fixture; SQL itself is covered by the guarded integration suite.
      const previousStatus = current.status;
      const final = new Set(["canceled", "refunded", "chargeback"]);
      if (!final.has(previousStatus) && (input.status === "paid" || final.has(input.status) || previousStatus !== "paid")) {
        current.status = input.status;
      }
      return { id: current.id, status: current.status, previousStatus };
    } };
  if (contract === "galatic-mysql") store.adminCancelUnpaidOrder = async () => {
    if (updateFailure) throw new Error("synthetic_store_failure");
    await onCancel?.(current);
    if (rejectUpdate || ["paid", "refunded", "chargeback"].includes(current.status)) return false;
    current.status = "canceled";
    stockReleases += 1;
    return true;
  };
  const asaasClient = createAsaasClient({ asaasAvailable: true, asaasApiOrigin: "https://synthetic.invalid/v3", asaasApiKey: "synthetic" }, async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method });
    assert.equal(options.method, "GET", "reads must never mutate the provider");
    if (url.endsWith("/pixQrCode")) {
      await onQr?.(current);
      return new Response(JSON.stringify(qr), { status: 200 });
    }
    await onPayment?.(current);
    return new Response(JSON.stringify(provider404 ? { errors: [{ code: "invalid_action" }] } : (payment && typeof payment === "object" ? { customer: "cus_profile_fixture", billingType: method === "pix" ? "PIX" : "CREDIT_CARD", value: 100, externalReference: `galatic:${current.id}`, ...payment } : payment)), { status: provider404 ? 404 : 200 });
  });
  let academyWrites = 0;
  const academy = { ...createInMemoryStore(), updateOrderFromWebhook: async () => { academyWrites += 1; assert.fail("Academy mutation"); } };
  const runtime = createApp(source, { stores: { galatic: store, academy4u: academy }, asaasClient });
  await runtime.ready;
  const server = runtime.app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async (suffix = "") => {
    const response = await fetch(`${base}/v1/galatic/checkout/orders/${current.id}${suffix}`);
    return { http: response.status, body: await response.json() };
  };
  return { read, calls, transitions, current, base, academyWrites: () => academyWrites, stockReleases: () => stockReleases };
}

for (const contract of ["galatic-mysql", "in-memory"]) {
  for (const status of ["PENDING", "OVERDUE", "UNKNOWN_PROVIDER_STATUS"]) {
    test(`${contract}: failed order ignores stale ${status} without exposing Pix`, async (t) => {
      const f = await fixture(t, { contract, initial: "failed", payment: { id: providerOrderId, status } });
      assert.equal((await f.read()).body.status, "failed");
      assert.deepEqual(await f.read("/pix"), { http: 200, body: { id: f.current.id, status: "failed" } });
      assert.equal(f.current.status, "failed");
      assert.equal(f.transitions.length, 0);
      assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
    });
  }
  for (const [status, resolved] of [["RECEIVED", "paid"], ["REFUNDED", "refunded"], ["CHARGEBACK_REQUESTED", "chargeback"]]) {
    test(`${contract}: failed order still accepts positive ${status} evidence`, async (t) => {
      const f = await fixture(t, { contract, initial: "failed", payment: { id: providerOrderId, status } });
      assert.equal((await f.read()).body.status, resolved);
      assert.equal((await f.read("/pix")).body.status, resolved);
      assert.equal(f.current.status, resolved);
      assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
    });
  }
  for (const initial of ["canceled", "refunded", "chargeback"]) {
    for (const status of ["PENDING", "RECEIVED"]) test(`${contract}: ${initial} cannot reopen or expose Pix on stale ${status}`, async (t) => {
      const f = await fixture(t, { contract, initial, payment: { id: providerOrderId, status, deleted: true } });
      assert.equal((await f.read()).body.status, initial);
      assert.deepEqual(await f.read("/pix"), { http: 200, body: { id: f.current.id, status: initial } });
      assert.equal(f.calls.length, 0);
      assert.equal(f.transitions.length, 0);
      assert.equal(f.academyWrites(), 0);
    });
  }
  for (const deleted of [false, true]) test(`${contract}: paid survives stale pending deleted=${deleted}`, async (t) => {
    const f = await fixture(t, { contract, initial: "paid", payment: { id: providerOrderId, status: "PENDING", deleted } });
    assert.equal((await f.read()).body.status, "paid");
    assert.equal((await f.read("/pix")).body.status, "paid");
    assert.equal(f.calls.filter((call) => call.path.endsWith("/pixQrCode")).length, 0);
    assert.equal(f.transitions.filter((item) => item.status === "canceled").length, 0);
  });
  test(`${contract}: a paid order can still reconcile to refunded`, async (t) => {
    const f = await fixture(t, { contract, initial: "paid", payment: { id: providerOrderId, status: "REFUNDED", deleted: true } });
    assert.equal((await f.read()).body.status, "refunded");
    assert.equal((await f.read("/pix")).body.status, "refunded");
    assert.equal(f.current.status, "refunded");
    assert.equal(f.calls.length, 1);
  });
  test(`${contract}: deleted unpaid payment never yields QR when its store accepts or rejects cancellation`, async (t) => {
    const f = await fixture(t, { contract, payment: { id: providerOrderId, status: "PENDING", deleted: true } });
    const result = await f.read("/pix");
    assert.equal(result.http, 502);
    assert.equal(f.current.status, "open");
    assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
  });
  test(`${contract}: valid pending Pix remains available`, async (t) => {
    const f = await fixture(t, { contract });
    const result = await f.read("/pix");
    assert.equal(result.http, 200);
    assert.equal(result.body.status, "open");
    assert.equal(result.body.pix.emv, qr.payload);
    assert.equal(f.calls.length, 2);
  });
}

test("a stale pending snapshot returns the actual in-memory processing status", async (t) => {
  const f = await fixture(t, { contract: "in-memory", initial: "processing" });
  assert.equal((await f.read()).body.status, "processing");
  assert.equal(f.current.status, "processing");
});

for (const status of ["REFUNDED", "CHARGEBACK_REQUESTED", "RECEIVED"]) {
  test(`provider ${status} is reconciled before Pix and never yields QR`, async (t) => {
    const expected = { CANCELED: "canceled", REFUNDED: "refunded", CHARGEBACK_REQUESTED: "chargeback", RECEIVED: "paid" }[status];
    const f = await fixture(t, { payment: { id: providerOrderId, status } });
    assert.equal((await f.read("/pix")).body.status, expected);
    assert.equal(f.current.status, expected);
    assert.equal(f.calls.length, 1);
  });
}

for (const status of ["RECEIVED", "REFUNDED", "CHARGEBACK_REQUESTED"]) test(`deleted flag cannot demote provider ${status}`, async (t) => {
  const f = await fixture(t, { payment: { id: providerOrderId, status, deleted: true } });
  const expected = { RECEIVED: "paid", REFUNDED: "refunded", CHARGEBACK_REQUESTED: "chargeback" }[status];
  assert.equal((await f.read()).body.status, expected);
  assert.equal((await f.read("/pix")).body.status, expected);
  assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
});

for (const options of [{ updateFailure: true }, { rejectUpdate: true }]) test(`deleted QR stays blocked on reconciliation ${options.updateFailure ? "failure" : "rejection"}`, async (t) => {
  const f = await fixture(t, { ...options, payment: { id: providerOrderId, status: "PENDING", deleted: true } });
  assert.equal((await f.read()).body.status, "open");
  assert.equal((await f.read("/pix")).http, 502);
  assert.equal(f.current.status, "open");
  assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
});

for (const payment of [null, {}, { id: providerOrderId }, { id: "pay_another", status: "PENDING" }]) test(`invalid provider snapshot ${JSON.stringify(payment)} cannot invent payable state`, async (t) => {
  const f = await fixture(t, { payment });
  assert.equal((await f.read()).body.status, "open");
  assert.equal((await f.read("/pix")).http, 502);
  assert.equal(f.transitions.length, 0);
  assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
});

test("legacy provider404 keeps order fallback and pending Pix502", async (t) => {
  const f = await fixture(t, { provider404: true });
  assert.equal((await f.read()).body.status, "open");
  assert.deepEqual(await f.read("/pix"), { http: 502, body: { error: "pix_retrieval_failed" } });
  assert.equal(f.transitions.length, 0);
});

for (const stage of ["payment", "qr"]) test(`cancellation committed during provider ${stage} request blocks QR response`, async (t) => {
  const cancel = async (current) => { current.status = "canceled"; };
  const f = await fixture(t, { onPayment: stage === "payment" ? cancel : null, onQr: stage === "qr" ? cancel : null });
  const result = await f.read("/pix");
  assert.deepEqual(result, { http: 200, body: { id: f.current.id, status: "canceled" } });
  assert.equal(f.calls.filter((call) => call.path.endsWith("/pixQrCode")).length, stage === "payment" ? 0 : 1);
});

for (const stage of ["payment", "qr"]) test(`payment binding changed during ${stage} cannot expose old QR or reconcile wrong payment`, async (t) => {
  const rebind = async (current) => { current.providerOrderId = "pay_replacement"; };
  const f = await fixture(t, { onPayment: stage === "payment" ? rebind : null, onQr: stage === "qr" ? rebind : null });
  assert.deepEqual(await f.read("/pix"), { http: 502, body: { error: "pix_retrieval_failed" } });
  assert.equal(f.transitions.length, 0);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/pixQrCode")).length, stage === "payment" ? 0 : 1);
});

test("order removal during QR retrieval returns controlled404 with no QR", async (t) => {
  const f = await fixture(t, { onQr: async (current) => { current.removed = true; } });
  assert.deepEqual(await f.read("/pix"), { http: 404, body: { error: "order_not_found" } });
});

for (const stage of ["payment"]) test(`payment committed during ${stage} cannot be demoted by deleted pending`, async (t) => {
  const paid = async (current) => { current.status = "paid"; };
  const f = await fixture(t, { payment: { id: providerOrderId, status: "PENDING", deleted: true },
    onPayment: stage === "payment" ? paid : null, onCancel: stage === "cancellation-lock" ? paid : null });
  assert.equal((await f.read()).body.status, "paid");
  assert.equal((await f.read("/pix")).body.status, "paid");
  assert.equal(f.current.status, "paid");
  assert.equal(f.stockReleases(), 0);
  assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
});

for (const payment of [{ id: providerOrderId, status: "UNKNOWN", deleted: true }, { id: providerOrderId, status: "PENDING", deleted: "true" }]) {
  test(`ambiguous deleted snapshot ${JSON.stringify(payment)} cannot cancel or expose QR`, async (t) => {
    const f = await fixture(t, { payment });
    assert.equal((await f.read()).body.status, "open");
    assert.equal((await f.read("/pix")).http, 502);
    assert.equal(f.stockReleases(), 0);
    assert.equal(f.calls.some((call) => call.path.endsWith("/pixQrCode")), false);
  });
}

test("missing, invalid and non-Pix public orders retain404 without provider calls", async (t) => {
  const f = await fixture(t, { method: "credit_card" });
  assert.equal((await f.read("/pix")).http, 404);
  for (const id of ["invalid", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    for (const suffix of ["", "/pix"]) assert.equal((await fetch(`${f.base}/v1/galatic/checkout/orders/${id}${suffix}`)).status, 404);
  }
  assert.equal(f.calls.length, 0);
});
