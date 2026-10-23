import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { createGalaticMySqlStore } from "../src/store/galatic-mysql-store.js";
import { createGalaticPaymentRecovery } from "../src/services/galatic-payment-recovery.js";
import { createApp } from "../src/application.js";

const databaseUrl = process.env.MYSQL_TEST_URL;
const logistics = { weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 };
const buyer = { email: "guest@example.test", name: "Synthetic Buyer", document: "52998224725", phone: "11999999999",
  address: { postCode: "01001000", street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP" } };

test("Galatic transactions against local disposable MySQL", { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Only a local synthetic MySQL is allowed");
  assert.match(url.pathname, /^\/galatic_test_[A-Za-z0-9_]+$/, "Refuse to reset any non-test schema");
  const db = await mysql.createConnection(databaseUrl);
  t.after(() => db.end());
  await db.query("SET FOREIGN_KEY_CHECKS=0");
  const [tables] = await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
  for (const { name } of tables) {
    assert.match(name, /^[A-Za-z0-9_]+$/);
    await db.query(`DROP TABLE \`${name}\``);
  }
  await db.query("SET FOREIGN_KEY_CHECKS=1");
  await db.query(`CREATE TABLE products (sku VARCHAR(80) PRIMARY KEY,name VARCHAR(180),unit_amount INT,stock_quantity INT,
    manage_stock TINYINT,active TINYINT,weight_grams INT,length_cm INT,width_cm INT,height_cm INT)`);
  await db.query("INSERT INTO products VALUES ('TEST01','Synthetic game',10000,100,1,1,1000,30,20,10)");
  const stores = [];
  function newStore() { const store = createGalaticMySqlStore(databaseUrl); stores.push(store); return store; }
  t.after(() => Promise.all(stores.map((store) => store.close())));
  const store = newStore();
  const replica = newStore();

  await t.test("an interrupted import rolls back both products and migration marker, then a fresh process can retry", async () => {
    await db.query("INSERT INTO products VALUES ('TEST_02','Collision A',10000,10,1,1,1000,30,20,10),('TEST-02','Collision B',10000,10,1,1,1000,30,20,10)");
    await assert.rejects(() => newStore().ensureSchema(), { code: "ER_DUP_ENTRY" });
    const [[products]] = await db.query("SELECT COUNT(*) total FROM galatic_products");
    const [[markers]] = await db.query("SELECT COUNT(*) total FROM galatic_schema_migrations WHERE migration_key='legacy_catalog_v1'");
    assert.equal(products.total, 0); assert.equal(markers.total, 0);
    await db.query("DELETE FROM products WHERE sku IN ('TEST_02','TEST-02')");
  });

  await t.test("concurrent bootstrap imports once, records migration, and preserves edited stock on restart", async () => {
    await Promise.all([store.ensureSchema(), replica.ensureSchema()]);
    const [[initial]] = await db.query("SELECT COUNT(*) total,MAX(stock_quantity) stock FROM galatic_products");
    assert.equal(initial.total, 1); assert.equal(initial.stock, 100);
    await db.query("UPDATE galatic_products SET stock_quantity=20,unit_amount_cents=12000 WHERE sku='TEST01'");
    await newStore().ensureSchema();
    const [[after]] = await db.query("SELECT stock_quantity,unit_amount_cents FROM galatic_products WHERE sku='TEST01'");
    assert.deepEqual(after, { stock_quantity: 20, unit_amount_cents: 12000 });
    const [[migration]] = await db.query("SELECT completed_at FROM galatic_schema_migrations WHERE migration_key='legacy_catalog_v1'");
    assert.ok(migration.completed_at);
  });

  async function quote(postcode = "01001000", itemLogistics = logistics) {
    return (await store.createShippingQuotes({ destinationPostcode: postcode,
      items: [{ sku: "TEST01", quantity: 1, logistics: itemLogistics }],
      quotes: [{ serviceCode: "correios:pac", serviceName: "PAC", amountCents: 2500, deliveryDays: 4 }] }))[0].id;
  }
  async function prepare(extra = {}, target = store) {
    return target.prepareOrder({ key: randomUUID(), fingerprint: "a".repeat(64), items: [{ key: "TEST01", quantity: 1 }],
      quoteId: await quote(), buyer, ...extra });
  }
  let paidOrder;
  await t.test("upgrading an old pending operation preserves its unknown external outcome", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    await db.query("UPDATE galatic_checkout_attempts SET operation_version=0 WHERE idempotency_key=?", [key]);
    await db.query("DELETE FROM galatic_schema_migrations WHERE migration_key='financial_operations_v1'");
    const upgraded = newStore(); await upgraded.ensureSchema();
    assert.equal((await upgraded.getCheckoutRecovery({ key })).state, "uncertain");
    await assert.rejects(() => upgraded.adminCancelUnpaidOrder(order.id), { code: "payment_reconciliation_required" });
    const [[operation]] = await db.query("SELECT error_code FROM galatic_checkout_attempts WHERE idempotency_key=?", [key]);
    assert.equal(operation.error_code, "legacy_payment_operation");
  });
  await t.test("rejects mismatched destination and changed logistics without consuming quote or stock", async () => {
    const quoteId = await quote("99999999");
    const [[before]] = await db.query("SELECT stock_quantity FROM galatic_products WHERE sku='TEST01'");
    await assert.rejects(() => prepare({ quoteId }), { code: "shipping_quote_mismatch" });
    const badLogistics = await quote("01001000", { ...logistics, weight_grams: 500 });
    await assert.rejects(() => prepare({ quoteId: badLogistics }), { code: "shipping_quote_mismatch" });
    const [[after]] = await db.query("SELECT stock_quantity FROM galatic_products WHERE sku='TEST01'");
    assert.equal(after.stock_quantity, before.stock_quantity);
    const [[row]] = await db.query("SELECT status FROM galatic_shipping_quotes WHERE id=?", [quoteId]);
    assert.equal(row.status, "quoted");
  });

  await t.test("simultaneous use of the same key reserves and creates exactly one order", async () => {
    const quoteId = await quote(); const key = randomUUID();
    const input = { key, fingerprint: "b".repeat(64), items: [{ key: "TEST01", quantity: 1 }], quoteId, buyer };
    const results = await Promise.allSettled([store.prepareOrder(input), replica.prepareOrder(input)]);
    assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.kind === "created").length, 1);
    // An InnoDB deadlock is a retryable whole transaction failure, never a duplicate order.
    const retry = await store.prepareOrder(input);
    assert.equal(retry.kind, "pending");
    const [[count]] = await db.query("SELECT COUNT(*) total FROM galatic_orders WHERE id=?", [retry.orderId]);
    assert.equal(count.total, 1);
  });

  await t.test("guest order privacy requires actual verified email and rejects a forged caller flag", async () => {
    const customer = await store.createCustomer({ firstName: "Synthetic", lastName: "Buyer", email: buyer.email,
      phone: buyer.phone, passwordHash: "synthetic-hash", marketingConsent: false, termsVersion: "v1" });
    const order = (await prepare()).order;
    assert.deepEqual(await store.listCustomerOrders({ id: customer.id, email: buyer.email, email_verified: true }), []);
    assert.equal(await store.getCustomerOrder({ id: customer.id, email: buyer.email, email_verified: true }, order.id), null);
    await store.createCustomerToken({ customerId: customer.id, purpose: "verify_email", tokenHash: "c".repeat(64), expiresAt: new Date(Date.now() + 60_000) });
    assert.equal(await store.consumeCustomerToken("c".repeat(64), "verify_email"), customer.id);
    assert.ok((await store.listCustomerOrders(customer)).some((row) => row.order_number === order.id));
    assert.equal((await store.getCustomerOrder(customer, order.id)).order.shipping_address.postCode, buyer.address.postCode);
    const foreign = await store.createCustomer({ firstName: "Other", lastName: "Buyer", email: "other@example.test",
      phone: buyer.phone, passwordHash: "synthetic", marketingConsent: false, termsVersion: "v1" });
    assert.equal(await store.getCustomerOrder({ ...foreign, email: buyer.email, email_verified: true }, order.id), null);
  });

  await t.test("last coupon use is reserved across open payments and released on definitive cancellation", async () => {
    await store.adminCreateCoupon({ code: "LASTONE", type: "fixed", value: 1000, minimum: 0, limit: 1, perCustomer: 1 });
    const first = await prepare({ couponCode: "LASTONE" });
    await assert.rejects(() => prepare({ couponCode: "LASTONE", buyer: { ...buyer, email: "second@example.test" } }), { code: "invalid_coupon" });
    await store.adminCancelUnpaidOrder(first.order.id);
    const second = await prepare({ couponCode: "LASTONE" });
    assert.equal(second.order.discountCents, 1000);
  });

  await t.test("competing transactions for different SKUs cannot overbook the last coupon", async () => {
    await db.query("INSERT INTO galatic_products (sku,slug,title,unit_amount_cents,active,manage_stock,stock_quantity,weight_grams,length_cm,width_cm,height_cm) VALUES ('OTHER01','other01','Synthetic Other',12000,1,1,10,1000,30,20,10)");
    await store.adminCreateCoupon({ code: "RACEONE", type: "fixed", value: 1000, minimum: 0, limit: 1, perCustomer: 1 });
    const otherQuote = (await store.createShippingQuotes({ destinationPostcode: "01001000", items: [{ sku: "OTHER01", quantity: 1, logistics }],
      quotes: [{ serviceCode: "correios:pac", serviceName: "PAC", amountCents: 2500, deliveryDays: 4 }] }))[0].id;
    const results = await Promise.allSettled([prepare({ couponCode: "RACEONE" }), prepare({ couponCode: "RACEONE", quoteId: otherQuote,
      items: [{ key: "OTHER01", quantity: 1 }], buyer: { ...buyer, email: "competitor@example.test" } }, replica)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "invalid_coupon").length, 1);
    const [[count]] = await db.query("SELECT COUNT(*) total FROM galatic_orders WHERE coupon_code='RACEONE' AND stock_released_at IS NULL");
    assert.equal(count.total, 1);
  });

  await t.test("an inbox event received before the creation claim is applied after attach instead of discarded as a duplicate", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    const evidence = { id: "pay_synthetic_deferred", customer: "cus_synthetic", billingType: "PIX", value: order.totalCents / 100, externalReference: `galatic:${order.id}` };
    const input = { provider: "asaas", providerOrderId: evidence.id, status: "paid", eventId: "evt_synthetic_deferred", externalReference: evidence.externalReference, paymentEvidence: evidence };
    assert.equal((await store.updateOrderFromWebhook(input)).deferred, true);
    assert.equal((await store.updateOrderFromWebhook(input)).deferred, true);
    await store.beginPaymentCreation(key, order.id, { customerId: "cus_synthetic", pricing: { baseCents: order.totalCents, totalCents: order.totalCents, installmentCents: order.totalCents, feeCents: 0 } });
    await store.attachPayment(order.id, evidence.id, "open", { totalCents: order.totalCents, installmentAmountCents: order.totalCents });
    assert.equal((await store.getOrderByPublicId(order.id)).status, "paid");
    const [[event]] = await db.query("SELECT applied_at FROM galatic_payment_events WHERE event_id=?", [input.eventId]);
    assert.ok(event.applied_at);
  });

  await t.test("invalid inbox evidence stays rejected after attach and a changed duplicate cannot launder the event", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    const wrong = { id: "pay_invalid_evidence", customer: "cus_foreign", billingType: "PIX", value: 1, externalReference: `galatic:${order.id}` };
    const input = { provider: "asaas", providerOrderId: wrong.id, status: "paid", eventId: "evt_invalid_evidence", externalReference: wrong.externalReference, paymentEvidence: wrong };
    assert.equal((await store.updateOrderFromWebhook(input)).deferred, true);
    await store.beginPaymentCreation(key, order.id, { customerId: "cus_synthetic", pricing: { baseCents: order.totalCents, totalCents: order.totalCents, installmentCents: order.totalCents, feeCents: 0 } });
    await store.attachPayment(order.id, wrong.id, "open", { totalCents: order.totalCents });
    assert.equal((await store.getOrderByPublicId(order.id)).status, "open");
    const changed = await store.updateOrderFromWebhook({ ...input, paymentEvidence: { ...wrong, customer: "cus_synthetic", value: order.totalCents / 100 } });
    assert.equal(changed.rejectedEvidence, true);
    assert.equal((await store.getOrderByPublicId(order.id)).status, "open");
    const [[event]] = await db.query("SELECT applied_at,validation_error,payment_evidence_json FROM galatic_payment_events WHERE event_id=?", [input.eventId]);
    assert.equal(event.applied_at, null); assert.equal(event.validation_error, "payment_evidence_mismatch");
    assert.equal(event.payment_evidence_json.customer, "cus_foreign");
    const valid = await store.updateOrderFromWebhook({ ...input, eventId: "evt_valid_new_identity", paymentEvidence: { ...wrong, customer: "cus_synthetic", value: order.totalCents / 100 } });
    assert.equal(valid.status, "paid");
  });

  await t.test("canceling a pre-creation reservation completes the attempt and forbids a late creation claim", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    await store.adminCancelUnpaidOrder(order.id);
    const result = await store.getCheckoutAttemptResult(key);
    assert.equal(result.state, "completed"); assert.equal(result.response.body.status, "canceled");
    await assert.rejects(() => store.beginPaymentCreation(key, order.id, { customerId: "cus_synthetic", pricing: { totalCents: order.totalCents } }), { code: "payment_operation_already_started" });
    assert.equal((await store.getOrderByPublicId(order.id)).status, "canceled");
  });

  await t.test("durable creation claim survives restart and only one replica can own the POST", async () => {
    const key = randomUUID(); const result = await prepare({ key }); paidOrder = result.order;
    const details = { customerId: "cus_synthetic", pricing: { baseCents: paidOrder.totalCents, totalCents: paidOrder.totalCents,
      installmentCents: paidOrder.totalCents, feeCents: 0 } };
    const claims = await Promise.allSettled([store.beginPaymentCreation(key, paidOrder.id, details), replica.beginPaymentCreation(key, paidOrder.id, details)]);
    assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
    await store.markPaymentCreationUncertain(key, "synthetic_timeout");
    const restarted = newStore(); await restarted.ensureSchema();
    const operation = await restarted.getCheckoutRecovery({ key });
    assert.equal(operation.state, "uncertain");
    assert.equal(operation.pricing.totalCents, paidOrder.totalCents);
    await assert.rejects(() => restarted.adminCancelUnpaidOrder(paidOrder.id), { code: "payment_reconciliation_required" });
    await db.query("UPDATE galatic_checkout_attempts SET reconcile_after=UTC_TIMESTAMP(3) WHERE idempotency_key=?", [key]);
    const batches = await Promise.all([store.claimPaymentReconciliations(), replica.claimPaymentReconciliations()]);
    assert.equal(batches.flat().filter((item) => item.key === key).length, 1);
    const recover = createGalaticPaymentRecovery({ store: restarted, asaasClient: { findPaymentsByExternalReference: async () => ({ data: [] }) } });
    await assert.rejects(() => recover({ key }), { code: "payment_not_yet_found" });
    assert.equal((await restarted.getCheckoutRecovery({ key })).state, "uncertain");
    const evidence = { id: "pay_synthetic_paid", customer: details.customerId, billingType: "PIX", value: paidOrder.totalCents / 100,
      externalReference: `galatic:${paidOrder.id}` };
    const early = await restarted.updateOrderFromWebhook({ provider: "asaas", providerOrderId: evidence.id, status: "paid",
      externalReference: evidence.externalReference, paymentEvidence: evidence, eventId: "evt_synthetic_early" });
    assert.equal(early.id, paidOrder.id); assert.equal(early.status, "paid"); assert.equal(early.deferred, false);
    await restarted.attachPayment(paidOrder.id, evidence.id, "open", { totalCents: paidOrder.totalCents, installmentAmountCents: paidOrder.totalCents });
    assert.equal((await restarted.getOrderByPublicId(paidOrder.id)).status, "paid");
    assert.equal((await restarted.getOrderByPublicId(paidOrder.id)).fulfillmentStatus, "preparing");
    const [[inbox]] = await db.query("SELECT applied_at FROM galatic_payment_events WHERE event_id='evt_synthetic_early'");
    assert.ok(inbox.applied_at);
    const duplicate = await restarted.updateOrderFromWebhook({ provider: "asaas", providerOrderId: evidence.id, status: "paid", eventId: "evt_synthetic_early" });
    assert.equal(duplicate.duplicate, true);
    const [[jobs]] = await db.query("SELECT COUNT(*) total FROM galatic_notification_outbox WHERE order_id=? AND method='sendPaymentConfirmed'", [paidOrder.id]);
    assert.equal(jobs.total, 1);
  });

  await t.test("outbox lease recovers after crash, deduplicates concurrent workers and rejects an old worker completion", async () => {
    const key = `synthetic:${randomUUID()}`;
    await store.enqueueNotification(key, paidOrder.id, "sendPaymentConfirmed");
    const first = (await store.claimNotificationJobs()).find((job) => job.key === key);
    assert.ok(first);
    assert.equal((await replica.claimNotificationJobs()).some((job) => job.key === key), false);
    await db.query("UPDATE galatic_notification_outbox SET lease_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE notification_key=?", [key]);
    const retry = (await replica.claimNotificationJobs()).find((job) => job.key === key);
    assert.ok(retry); assert.notEqual(retry.lease, first.lease);
    await store.completeNotificationJob(key, first.lease);
    const [[unfinished]] = await db.query("SELECT state FROM galatic_notification_outbox WHERE notification_key=?", [key]);
    assert.equal(unfinished.state, "sending");
    await replica.completeNotificationJob(key, retry.lease);
    const [[finished]] = await db.query("SELECT state,attempts FROM galatic_notification_outbox WHERE notification_key=?", [key]);
    assert.equal(finished.state, "sent"); assert.equal(finished.attempts, 2);
  });

  await t.test("late shipping events never regress delivery or overwrite a financial reversal", async () => {
    await store.saveShipment(paidOrder.id, { providerShipmentId: "ship_synthetic", carrier: "correios", service: "pac", trackingCode: "SYNTHETIC123",
      labelUrl: "https://example.test/label", trackUrl: null, costCents: 2500, currency: "BRL" });
    await store.updateShipmentFromEvent({ eventId: "ship_delivered", eventType: "synthetic", trackingCode: "SYNTHETIC123", status: "delivered", occurredAt: "2026-10-23T12:00:00Z" });
    const delayed = await store.updateShipmentFromEvent({ eventId: "ship_delayed", eventType: "synthetic", trackingCode: "SYNTHETIC123", status: "in_transit", occurredAt: "2026-10-23T11:00:00Z" });
    assert.equal(delayed.updated, false);
    assert.equal((await store.shipmentForOrder(paidOrder.id)).status, "delivered");
    await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_synthetic_paid", status: "refunded", eventId: "evt_synthetic_refund" });
    await store.updateShipmentFromEvent({ eventId: "ship_repeat_delivered", eventType: "synthetic", trackingCode: "SYNTHETIC123", status: "delivered" });
    assert.equal((await store.getOrderByPublicId(paidOrder.id)).fulfillmentStatus, "payment_reversed");
  });

  await t.test("a group refund is claimed once, survives restart uncertain, and only confirmation reverses the order", async () => {
    const key = randomUUID(); const { order } = await prepare({ key, paymentMethod: "credit_card", installments: 2 });
    await store.beginPaymentCreation(key, order.id, { customerId: "cus_synthetic", pricing: { baseCents: order.totalCents, totalCents: order.totalCents, installmentCents: order.totalCents / 2, feeCents: 0 } });
    await store.attachPayment(order.id, "pay_refund_group_1", "paid", { totalCents: order.totalCents, providerGroupId: "ins_refund_group" });
    const rejected = await store.claimRefund(order.id, "synthetic-admin");
    await store.finishRefundRequest(order.id, "rejected", "insufficient_balance", rejected.version);
    const claims = await Promise.all([store.claimRefund(order.id, "synthetic-admin"), replica.claimRefund(order.id, "synthetic-admin")]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    const version = claims.find((claim) => claim.claimed).version;
    assert.equal(version, 2);
    await store.finishRefundRequest(order.id, "requested", null, rejected.version);
    assert.equal((await store.adminRefundOperations()).find((row) => row.order_id === order.id).state, "in_progress");
    assert.equal(claims.find((claim) => claim.claimed).providerReference, "ins_refund_group");
    assert.equal(claims.find((claim) => claim.claimed).group, true);
    await store.finishRefundRequest(order.id, "uncertain", "synthetic_timeout", version);
    assert.equal((await store.getOrderByPublicId(order.id)).status, "paid");
    const restarted = newStore(); await restarted.ensureSchema();
    assert.equal((await restarted.claimRefund(order.id, "synthetic-admin")).claimed, false);
    await db.query("UPDATE galatic_payment_actions SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 3 MINUTE) WHERE order_id=? AND action='refund'", [order.id]);
    const lease = await restarted.claimRefundReconciliations();
    assert.equal(lease.filter((item) => item.id === order.id).length, 1);
    assert.equal((await store.claimRefundReconciliations()).filter((item) => item.id === order.id).length, 0);
    await restarted.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_refund_group_1", providerGroupId: "ins_refund_group", status: "refunded" });
    assert.equal((await restarted.getOrderByPublicId(order.id)).status, "refunded");
    const [[operation]] = await db.query("SELECT state FROM galatic_payment_actions WHERE order_id=? AND action='refund'", [order.id]);
    assert.equal(operation.state, "completed");
    const history = await store.adminRefundHistory(order.id);
    assert.equal(history.length, 2); assert.equal(history[0].state, "rejected"); assert.equal(history[1].state, "completed");
  });

  await t.test("zero active products keep preopening status and post-sale routes available", async () => {
    await db.query("UPDATE galatic_products SET active=0");
    const inactiveStore = newStore(); await inactiveStore.ensureSchema();
    const runtime = createApp({ PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br", GALATIC_SALES_ENABLED: "false" }, { stores: { galatic: inactiveStore } });
    await runtime.ready;
    const server = runtime.app.listen(0, "127.0.0.1");
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const status = await fetch(`${base}/v1/galatic/checkout/status`);
      assert.equal(status.status, 200); assert.equal((await status.json()).salesEnabled, false);
      assert.equal((await fetch(`${base}/v1/galatic/checkout/orders/${paidOrder.id}`)).status, 200);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    await db.query("UPDATE galatic_products SET active=1");
  });
});
