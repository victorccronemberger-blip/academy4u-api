import { cutoverPaymentProfileIndexes, legacyBindingFingerprint } from "../src/store/galatic-payment-profile-store.js";
import { profileIdentityHash } from "../src/services/galatic-payment-profiles.js";
import { PROFILE_ID, WALLET_ID, syntheticProfiles } from "./helpers/payment-profiles.mjs";
import { createGalaticDeferredEventReconciliation } from "../src/services/galatic-payment-events.js";
import { createGalaticFinancialGate } from "../src/services/galatic-financial-gate.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { createGalaticMySqlStore } from "../src/store/galatic-mysql-store.js";
import { createGalaticPaymentRecovery } from "./helpers/payment-profiles.mjs";
import { createApp } from "../src/application.js";
import { tokenHash } from "../src/domain/password.js";
import { createGalaticPaymentMaintenance } from "./helpers/payment-profiles.mjs";

const databaseUrl = process.env.MYSQL_TEST_URL;
const logistics = { weight_grams: 1000, length_cm: 30, width_cm: 20, height_cm: 10 };
const buyer = { email: "guest@example.test", name: "Synthetic Buyer", document: "52998224725", phone: "11999999999",
  address: { postCode: "01001000", street: "Synthetic Street", number: "1", district: "Centro", city: "Sao Paulo", state: "SP" } };

test("Galatic transactions against local disposable MySQL", { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Only a local synthetic MySQL is allowed");
  assert.match(url.pathname, /^\/galatic_test_[A-Za-z0-9_]+$/, "Refuse to reset any non-test schema");
  const db = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
    timezone: "Z", dateStrings: true });
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
  function newStore() {
    const store = createGalaticMySqlStore(databaseUrl); stores.push(store);
    // These are synthetic, explicitly attributed provider confirmations. HTTP
    // webhook authentication and complete-group proof are covered separately.
    for (const method of ["prepareOrder", "updateOrderFromWebhook"]) {
      const actual = store[method].bind(store);
      store[method] = (input) => actual({ profileId: PROFILE_ID, completeGroupProof: true, ...input });
    }
    for (const method of ["beginPaymentCreation"]) {
      const actual = store[method].bind(store);
      store[method] = (key, orderId, details) => actual(key, orderId, { profileId: PROFILE_ID, ...details });
    }
    const attach = store.attachPayment.bind(store);
    store.attachPayment = (id, reference, status, details) => attach(id, reference, status, { profileId: PROFILE_ID, ...details });
    const cancel = store.adminCancelUnpaidOrder.bind(store);
    store.adminCancelUnpaidOrder = (id, proof) => cancel(id, { profileId: PROFILE_ID, ...proof });
    return store;
  }
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

  const identity = { id: PROFILE_ID, provider: "asaas", environment: "sandbox", expectedWalletId: WALLET_ID, allowedTenants: ["galatic"] };
  await store.registerPaymentProfileIdentity(identity, profileIdentityHash(identity));
  await db.query("UPDATE galatic_payment_profiles SET capabilities_json=?,commercial_approved=1,approval_evidence='synthetic-only' WHERE id=?",
    [JSON.stringify(["checkout", "read", "recovery", "refund", "cancel", "webhook", "fulfillment"]), PROFILE_ID]);
  await assert.rejects(() => store.assertPaymentProfileDispatchPhase(), { code: "payment_profile_cutover_required" });
  await t.test("T10: populated legacy facts survive additive expansion and an incomplete drain blocks cutover", async () => {
    const legacyId = randomUUID(), legacyKey = randomUUID();
    await db.query(`INSERT INTO galatic_orders (id,payment_provider,payment_provider_order_id,payment_status,buyer_email,buyer_name,
      shipping_address_json,subtotal_cents,shipping_cents,total_cents) VALUES (?,'asaas','pay_legacy_expand','paid','synthetic@example.test','Synthetic','{}',12000,2500,14500)`, [legacyId]);
    await db.query("INSERT INTO galatic_checkout_attempts(idempotency_key,request_fingerprint,order_id,state) VALUES (?, ?,?,'uncertain')", [legacyKey, "f".repeat(64), legacyId]);
    await db.query("INSERT INTO galatic_payment_events(event_id,provider,provider_order_id,status) VALUES ('evt_legacy_expand','asaas','pay_legacy_expand','paid')");
    await db.query("INSERT INTO galatic_payment_actions(order_id,action,state,provider_reference,admin_id) VALUES (?,'refund','uncertain','pay_legacy_expand','synthetic-reviewer')", [legacyId]);
    await db.query("INSERT INTO galatic_payment_action_attempts(order_id,action,attempt_version,state,provider_reference,admin_id) VALUES (?,'refund',1,'uncertain','pay_legacy_expand','synthetic-reviewer')", [legacyId]);
    const [[before]] = await db.query("SELECT payment_status,total_cents,payment_provider_order_id FROM galatic_orders WHERE id=?", [legacyId]);
    // Reconstruct the populated pre-Stage-B shape in this disposable schema.
    // The application upgrade must execute its ADD COLUMN/INDEX expansion on
    // rows that already exist, rather than merely re-ensuring an empty schema.
    await db.query("ALTER TABLE galatic_orders DROP INDEX galatic_orders_profile_provider");
    await db.query("ALTER TABLE galatic_payment_events DROP INDEX galatic_events_profile_event, DROP INDEX galatic_events_internal, DROP COLUMN internal_event_id, DROP COLUMN reconciliation_attempts, DROP COLUMN reconcile_after");
    for (const table of ["galatic_orders", "galatic_checkout_attempts", "galatic_payment_actions", "galatic_payment_action_attempts", "galatic_payment_events"]) {
      await db.query(`ALTER TABLE ${table} DROP COLUMN payment_profile_id, DROP COLUMN payment_namespace, DROP COLUMN binding_version`);
    }
    for (const table of ["galatic_payment_actions", "galatic_payment_action_attempts"]) await db.query(`ALTER TABLE ${table} DROP COLUMN reference_kind, DROP COLUMN snapshot_json`);
    await newStore().ensureSchema();
    const [[after]] = await db.query("SELECT payment_status,total_cents,payment_provider_order_id,payment_profile_id,payment_namespace FROM galatic_orders WHERE id=?", [legacyId]);
    assert.deepEqual(after, { ...before, payment_profile_id: null, payment_namespace: "legacy" });
    const [[event]] = await db.query("SELECT payment_profile_id,payment_namespace,internal_event_id FROM galatic_payment_events WHERE event_id='evt_legacy_expand'");
    assert.equal(event.payment_profile_id, null); assert.equal(event.payment_namespace, "legacy"); assert.match(event.internal_event_id, /^[a-f0-9-]{36}$/);
    const quoteId = (await store.createShippingQuotes({ destinationPostcode: buyer.address.postCode,
      items: [{ sku: "TEST01", quantity: 1, logistics }], quotes: [{ serviceCode: "correios:pac", serviceName: "PAC", amountCents: 2500, deliveryDays: 4 }] }))[0].id;
    const [[stockBefore]] = await db.query("SELECT stock_quantity FROM galatic_products WHERE sku='TEST01'");
    await assert.rejects(() => store.prepareOrder({ profileId: PROFILE_ID, key: randomUUID(), fingerprint: "a".repeat(64),
      buyer, quoteId, items: [{ key: "TEST01", quantity: 1 }] }), { code: "payment_profile_cutover_required" });
    const [[stockAfter]] = await db.query("SELECT stock_quantity FROM galatic_products WHERE sku='TEST01'"); assert.deepEqual(stockAfter, stockBefore);
    assert.equal((await db.query("SELECT status FROM galatic_shipping_quotes WHERE id=?", [quoteId]))[0][0].status, "quoted");
    await assert.rejects(() => cutoverPaymentProfileIndexes(db, { financialGateFalse: true, zeroInflight: true }), { code: "payment_profile_drain_not_proven" });
    const [[primary]] = await db.query("SELECT COLUMN_NAME col FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='galatic_payment_events' AND INDEX_NAME='PRIMARY'"); assert.equal(primary.col, "event_id");
  });
  await cutoverPaymentProfileIndexes(db, { allInstancesEnumerated: true, oldProcessesTerminated: true, bareAndWwwCovered: true,
    independentJobsCovered: true, financialGateFalse: true, zeroInflight: true, stageARevision: "a".repeat(40), evidenceReference: "synthetic-disposable-only" });
  await store.assertPaymentProfileDispatchPhase();
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
    const evidence = { id: "pay_synthetic_deferred", customer: "cus_synthetic", billingType: "PIX", status: "CONFIRMED", value: order.totalCents / 100, externalReference: `galatic:${order.id}` };
    const input = { provider: "asaas", providerOrderId: evidence.id, status: "paid", eventId: "evt_synthetic_deferred", externalReference: evidence.externalReference, paymentEvidence: evidence };
    assert.equal((await store.ingestAuthenticatedEvent({ profileId: PROFILE_ID, event: input })).deferred, true);
    assert.equal((await store.ingestAuthenticatedEvent({ profileId: PROFILE_ID, event: input })).deferred, true);
    await store.beginPaymentCreation(key, order.id, { customerId: "cus_synthetic", pricing: { baseCents: order.totalCents, totalCents: order.totalCents, installmentCents: order.totalCents, feeCents: 0 } });
    await store.attachPayment(order.id, evidence.id, "open", { totalCents: order.totalCents, installmentAmountCents: order.totalCents });
    assert.equal((await store.getOrderByPublicId(order.id)).status, "open", "attach cannot financially replay a historical receipt");
    const reconcile = createGalaticDeferredEventReconciliation({ store, paymentProfiles: syntheticProfiles(store, { getPayment: async () => evidence }),
      financialGate: createGalaticFinancialGate({ enabled: true }) });
    assert.equal((await reconcile({ profileId: PROFILE_ID, orderId: order.id })).applied, 1);
    assert.equal((await store.getOrderByPublicId(order.id)).status, "paid");
    const [[event]] = await db.query("SELECT applied_at FROM galatic_payment_events WHERE event_id=?", [input.eventId]);
    assert.ok(event.applied_at);
  });

  await t.test("T4/T5: an early canceled receipt cannot release stock when the current bound payment is pending", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    const evidence = { id: "pay_early_canceled", customer: "cus_synthetic", billingType: "PIX", value: order.totalCents / 100,
      externalReference: `galatic:${order.id}`, status: "CANCELED" };
    await store.ingestAuthenticatedEvent({ profileId: PROFILE_ID, event: { provider: "asaas", eventId: "evt_early_canceled", providerOrderId: evidence.id,
      externalReference: evidence.externalReference, status: "canceled", paymentEvidence: evidence } });
    await store.beginPaymentCreation(key, order.id, { customerId: evidence.customer, pricing: { totalCents: order.totalCents } });
    const [[before]] = await db.query("SELECT stock_quantity FROM galatic_products WHERE sku='TEST01'");
    await store.attachPayment(order.id, evidence.id, "open", { totalCents: order.totalCents });
    const reconcile = createGalaticDeferredEventReconciliation({ store, paymentProfiles: syntheticProfiles(store, { getPayment: async () => ({ ...evidence, status: "PENDING" }) }),
      financialGate: createGalaticFinancialGate({ enabled: true }) });
    const result = await reconcile({ profileId: PROFILE_ID, orderId: order.id }); assert.equal(result.applied, 0); assert.equal(result.pending, 1);
    const [[after]] = await db.query("SELECT stock_quantity FROM galatic_products WHERE sku='TEST01'"); assert.deepEqual(after, before);
    assert.equal((await store.getOrderByPublicId(order.id)).status, "open");
    const [[row]] = await db.query("SELECT stock_released_at FROM galatic_orders WHERE id=?", [order.id]); assert.equal(row.stock_released_at, null);
    const [[receipt]] = await db.query("SELECT status,applied_at FROM galatic_payment_events WHERE event_id='evt_early_canceled'");
    assert.equal(receipt.status, "canceled"); assert.equal(receipt.applied_at, null);
  });

  await t.test("invalid inbox evidence stays rejected after attach and a changed duplicate cannot launder the event", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    const wrong = { id: "pay_invalid_evidence", customer: "cus_foreign", billingType: "PIX", status: "CONFIRMED", value: 1, externalReference: `galatic:${order.id}` };
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
    for (let race = 0; race < 6; race += 1) {
      await db.query("UPDATE galatic_checkout_attempts SET reconcile_after=UTC_TIMESTAMP(3) WHERE idempotency_key=?", [key]);
      const batches = await Promise.all([store.claimPaymentReconciliations(), replica.claimPaymentReconciliations()]);
      assert.equal(batches.flat().filter((item) => item.key === key).length, 1);
    }
    const recover = createGalaticPaymentRecovery({ financialGate: createGalaticFinancialGate({ enabled: true }), store: restarted, asaasClient: { findPaymentsByExternalReference: async () => ({ data: [] }) } });
    await assert.rejects(() => recover({ key }), { code: "payment_not_yet_found" });
    assert.equal((await restarted.getCheckoutRecovery({ key })).state, "uncertain");
    const evidence = { id: "pay_synthetic_paid", customer: details.customerId, billingType: "PIX", status: "CONFIRMED", value: paidOrder.totalCents / 100,
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

  await t.test("refund operator reason survives reload and inconclusive maintenance while stale versions and completion remain protected", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    await store.beginPaymentCreation(key, order.id, { customerId: "cus_synthetic", pricing: { baseCents: order.totalCents, totalCents: order.totalCents, installmentCents: order.totalCents, feeCents: 0 } });
    await store.attachPayment(order.id, "pay_refund_operator", "paid", { totalCents: order.totalCents });
    const old = await store.claimRefund(order.id, "synthetic-admin");
    assert.equal(await store.recordRefundReconciliationError(order.id, "refund_authorization_required", old.version), false);
    assert.equal((await store.adminRefundOperation(order.id)).error_code, null);
    await store.finishRefundRequest(order.id, "rejected", "synthetic_rejection", old.version);
    const claim = await store.claimRefund(order.id, "synthetic-admin");
    assert.equal(await store.recordRefundReconciliationError(order.id, "stale_poll", old.version), false);
    assert.equal((await store.adminRefundOperation(order.id)).error_code, null);
    const finished = await store.finishRefundRequest(order.id, "requested", "refund_authorization_required", claim.version);
    assert.equal(finished.updated, true);
    const restarted = newStore();
    const expected = { state: "requested", attempt_version: 2, error_code: "refund_authorization_required",
      authorization_required: true, authorization_source: "refund_request_response" };
    assert.deepEqual(await restarted.adminRefundOperation(order.id), expected);
    assert.deepEqual((await restarted.adminOrder(order.id)).refund_operation, expected);
    assert.equal((await restarted.claimRefund(order.id, "synthetic-admin")).claimed, false);
    const maintenance = createGalaticPaymentMaintenance({ financialGate: createGalaticFinancialGate({ enabled: true }),
      environment: { galaticPaymentMaintenanceEnabled: true, galaticPixReservationMinutes: 60, galaticCardReservationMinutes: 4320 },
      store: { ...restarted, claimPaymentReconciliations: async () => [], listExpiredPaymentReservations: async () => [],
        claimRefundReconciliations: async () => (await restarted.claimRefundReconciliations()).filter((refund) => refund.id === order.id) },
      asaasClient: { getPayment: async (id) => {
        assert.equal(id, "pay_refund_operator");
        return { id, status: "RECEIVED", refunds: [{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }] };
      } },
    });
    await db.query("UPDATE galatic_payment_actions SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 3 MINUTE),reconcile_after=NULL WHERE order_id=? AND action='refund'", [order.id]);
    await maintenance.run();
    assert.deepEqual(await restarted.adminRefundOperation(order.id), expected);
    assert.equal(await restarted.recordRefundReconciliationError(order.id, "synthetic_network_error", claim.version), false);
    await restarted.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_refund_operator", status: "refunded" });
    assert.equal(await restarted.recordRefundReconciliationError(order.id, "late_poll", claim.version), false);
    const late = await restarted.finishRefundRequest(order.id, "requested", "refund_authorization_required", claim.version);
    assert.equal(late.updated, false); assert.equal(late.operation.state, "completed");
    assert.equal(late.operation.authorization_required, false); assert.equal(late.operation.error_code, null);
  });

  await t.test("webhook completion before the SDK result prevents requested notification and late history downgrade", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    await store.beginPaymentCreation(key, order.id, { customerId: "cus_synthetic", pricing: { baseCents: order.totalCents, totalCents: order.totalCents, installmentCents: order.totalCents, feeCents: 0 } });
    await store.attachPayment(order.id, "pay_refund_race", "paid", { totalCents: order.totalCents });
    const claim = await store.claimRefund(order.id, "synthetic-admin");
    await replica.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_refund_race", status: "refunded" });
    const result = await store.finishRefundRequest(order.id, "requested", "refund_authorization_required", claim.version);
    assert.equal(result.updated, false); assert.equal(result.operation.state, "completed");
    assert.equal(result.operation.error_code, null);
    const [[jobs]] = await db.query("SELECT COUNT(*) total FROM galatic_notification_outbox WHERE order_id=? AND method='sendRefundRequested'", [order.id]);
    assert.equal(jobs.total, 0);
    assert.equal((await store.adminRefundHistory(order.id))[0].state, "completed");
  });

  async function accountHttp(context) {
    // Each journey gets fresh limiter windows inside this already guarded, disposable schema.
    await db.query("DELETE FROM galatic_rate_limits WHERE scope IN ('galatic-auth-ip','galatic-auth-identity','galatic-public-write')");
    const messages = [];
    const methods = ["sendEmailVerification", "sendWelcome", "sendPasswordReset", "sendPasswordChanged",
      "sendNewsletterVerification", "sendNewsletterConfirmed", "sendNewsletterUnsubscribed"];
    const notifications = { ready: true, ...Object.fromEntries(methods.map((method) =>
      [method, async (value) => { messages.push({ method, ...value }); }])) };
    const runtime = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", NODE_ENV: "test", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
      GALATIC_SALES_ENABLED: "false", GALATIC_BOT_PROTECTION_ENABLED: "false" }, {
      stores: { galatic: newStore() }, galaticNotifications: notifications,
      // No payment, shipping or SMTP client can make an external request from these journeys.
      asaasClient: {}, enviaClient: {},
    });
    await runtime.ready;
    const server = runtime.app.listen(0, "127.0.0.1");
    context.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/v1/galatic`;
    async function request(path, body, cookie) {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { origin: "https://galatic.com.br", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
    }
    async function register() {
      const email = `account-${randomUUID()}@example.test`; const password = "SyntheticOriginal123";
      const response = await request("/auth/register", { first_name: "Synthetic", last_name: "Account", email, password,
        marketing_consent: false, terms_accepted: true, terms_version: "site-2026-10" });
      assert.equal(response.status, 201);
      assert.equal(response.body.customer.email_verified, false);
      assert.equal(response.body.access_token, undefined);
      assert.equal(response.body.customer.password_hash, undefined);
      assert.ok(/^__Host-galatic_session=/.test(response.cookie), "Registration must issue the customer cookie");
      for (const attribute of ["HttpOnly", "Secure", "Path=/", "SameSite=None", "Partitioned"]) {
        assert.ok(response.cookie.includes(attribute), `Session cookie requires ${attribute}`);
      }
      assert.ok(!response.cookie.includes("Max-Age="), "Registration creates a browser-session cookie");
      const verification = messages.find((message) => message.method === "sendEmailVerification" && message.customer.id === response.body.customer.id);
      assert.ok(verification?.token, "The locally captured verification message supplies the customer link");
      return { email, password, id: response.body.customer.id, cookie: response.cookie.split(";", 1)[0], token: verification.token };
    }
    async function rejectsToken(path, token, password = "SyntheticRejected123") {
      const response = await request(path, { token, ...(path === "/auth/reset-password" ? { password } : {}) });
      assert.equal(response.status, 400); assert.equal(response.body.error, "invalid_token");
    }
    return { messages, request, register, rejectsToken };
  }

  await t.test("HTTP account journey confirms email once, resets password once and revokes every earlier session", async (context) => {
    const { messages, request, register, rejectsToken } = await accountHttp(context);
    const account = await register();
    assert.equal((await request("/auth/me")).status, 401);
    const initial = await request("/auth/me", undefined, account.cookie);
    assert.equal(initial.status, 200); assert.equal(initial.body.customer.id, account.id);
    assert.equal(initial.body.customer.email_verified, false);
    assert.equal((await request("/auth/verify-email", { token: account.token })).status, 200);
    assert.equal((await request("/auth/me", undefined, account.cookie)).body.customer.email_verified, true);
    await rejectsToken("/auth/verify-email", account.token);
    assert.equal(messages.filter((message) => message.method === "sendWelcome").length, 1);

    const secondSession = await request("/auth/login", { email: account.email, password: account.password, remember: true });
    assert.equal(secondSession.status, 200);
    assert.ok(secondSession.cookie.includes("Max-Age=2592000"));
    const secondCookie = secondSession.cookie.split(";", 1)[0];
    assert.equal((await request("/auth/me", undefined, secondCookie)).status, 200);
    const forgotten = await request("/auth/forgot-password", { email: account.email });
    assert.equal(forgotten.status, 200);
    const reset = messages.find((message) => message.method === "sendPasswordReset");
    assert.ok(reset?.token);
    const newPassword = "SyntheticReplacement123";
    assert.equal((await request("/auth/reset-password", { token: reset.token, password: newPassword })).status, 200);
    for (const cookie of [account.cookie, secondCookie]) assert.equal((await request("/auth/me", undefined, cookie)).status, 401);
    const oldLogin = await request("/auth/login", { email: account.email, password: account.password });
    assert.equal(oldLogin.status, 401); assert.equal(oldLogin.body.error, "invalid_credentials");
    await rejectsToken("/auth/reset-password", reset.token);
    const newLogin = await request("/auth/login", { email: account.email, password: newPassword });
    assert.equal(newLogin.status, 200);
    const current = await request("/auth/me", undefined, newLogin.cookie.split(";", 1)[0]);
    assert.equal(current.status, 200); assert.equal(current.body.customer.id, account.id);
    assert.equal(current.body.customer.email_verified, true);
    assert.equal(current.body.customer.password_hash, undefined);
    assert.equal(messages.filter((message) => message.method === "sendPasswordChanged").length, 1);
  });

  await t.test("HTTP invalid and crossed-purpose links leave verification, password and existing session unchanged", async (context) => {
    const { messages, request, register, rejectsToken } = await accountHttp(context);
    const account = await register();
    await rejectsToken("/auth/verify-email", "synthetic-invalid-link");
    await rejectsToken("/auth/reset-password", "synthetic-invalid-link");
    await rejectsToken("/auth/reset-password", account.token);
    assert.equal((await request("/auth/forgot-password", { email: account.email })).status, 200);
    const reset = messages.find((message) => message.method === "sendPasswordReset");
    assert.ok(reset?.token);
    await rejectsToken("/auth/verify-email", reset.token);
    const unchanged = await request("/auth/me", undefined, account.cookie);
    assert.equal(unchanged.status, 200); assert.equal(unchanged.body.customer.email_verified, false);
    assert.equal((await request("/auth/login", { email: account.email, password: account.password })).status, 200);
    assert.equal(messages.filter((message) => ["sendWelcome", "sendPasswordChanged"].includes(message.method)).length, 0);
    // A wrong-purpose attempt must not consume the legitimate link either.
    assert.equal((await request("/auth/verify-email", { token: account.token })).status, 200);
    assert.equal((await request("/auth/reset-password", { token: reset.token, password: "SyntheticPurpose123" })).status, 200);
    assert.equal((await request("/auth/login", { email: account.email, password: "SyntheticPurpose123" })).status, 200);
  });

  await t.test("HTTP expired verification and recovery links cannot confirm email, change password or revoke sessions", async (context) => {
    const { messages, request, register, rejectsToken } = await accountHttp(context);
    const account = await register();
    assert.equal((await request("/auth/forgot-password", { email: account.email })).status, 200);
    const reset = messages.find((message) => message.method === "sendPasswordReset");
    assert.ok(reset?.token);
    // Expire the actual issued links in the disposable DB, avoiding waits or a fake store clock.
    const [expired] = await db.query("UPDATE galatic_customer_tokens SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE customer_id=? AND consumed_at IS NULL", [account.id]);
    assert.equal(expired.affectedRows, 2);
    await rejectsToken("/auth/verify-email", account.token);
    await rejectsToken("/auth/reset-password", reset.token);
    const unchanged = await request("/auth/me", undefined, account.cookie);
    assert.equal(unchanged.status, 200); assert.equal(unchanged.body.customer.email_verified, false);
    assert.equal((await request("/auth/login", { email: account.email, password: account.password })).status, 200);
    assert.equal(messages.filter((message) => ["sendWelcome", "sendPasswordChanged"].includes(message.method)).length, 0);
    const [[links]] = await db.query("SELECT COUNT(*) total FROM galatic_customer_tokens WHERE customer_id=? AND consumed_at IS NULL", [account.id]);
    assert.equal(links.total, 2);
  });

  await t.test("HTTP newsletter persists double opt-in and one-click cancellation with single-use links", async (context) => {
    const { messages, request } = await accountHttp(context);
    const email = `newsletter-${randomUUID()}@example.test`;
    assert.equal((await request("/newsletter/subscribe", { email, consent: true, consent_version: "site-2026-10" })).status, 200);
    const verification = messages.find((message) => message.method === "sendNewsletterVerification");
    assert.ok(verification?.token);
    const [[pending]] = await db.query("SELECT status,consent_version,action_token_hash FROM galatic_newsletter_subscribers WHERE email=?", [email]);
    assert.equal(pending.status, "pending"); assert.equal(pending.consent_version, "site-2026-10");
    assert.ok(pending.action_token_hash === tokenHash(verification.token), "Only a hash of the action link is persisted");
    assert.equal((await request("/newsletter/confirm", { token: verification.token })).status, 200);
    assert.equal((await request("/newsletter/confirm", { token: verification.token })).status, 400);
    const confirmation = messages.find((message) => message.method === "sendNewsletterConfirmed");
    assert.ok(confirmation?.unsubscribeToken);
    const [[active]] = await db.query("SELECT status FROM galatic_newsletter_subscribers WHERE email=?", [email]);
    assert.equal(active.status, "active");
    assert.equal((await request("/newsletter/unsubscribe", { token: confirmation.unsubscribeToken })).status, 200);
    assert.equal((await request("/newsletter/unsubscribe", { token: confirmation.unsubscribeToken })).status, 400);
    const [[unsubscribed]] = await db.query("SELECT status,action_token_hash FROM galatic_newsletter_subscribers WHERE email=?", [email]);
    assert.equal(unsubscribed.status, "unsubscribed"); assert.equal(unsubscribed.action_token_hash, null);
    assert.equal(messages.filter((message) => message.method === "sendNewsletterConfirmed").length, 1);
    assert.equal(messages.filter((message) => message.method === "sendNewsletterUnsubscribed").length, 1);
  });

  await t.test("zero active products keep preopening status and post-sale routes available", async () => {
    await db.query("UPDATE galatic_products SET active=0");
    const inactiveStore = newStore(); await inactiveStore.ensureSchema();
    const runtime = createApp({ GALATIC_FINANCIAL_OPERATIONS_ENABLED: "true", PAYMENT_TENANTS: "galatic", GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br", GALATIC_SALES_ENABLED: "false" }, { stores: { galatic: inactiveStore } });
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

  await t.test("T3: customer and payment dispatch claims remain exclusive after process replacement and uncertain outcomes", async () => {
    await db.query("UPDATE galatic_products SET stock_quantity=100 WHERE sku='TEST01'");
    const key = randomUUID(); const { order } = await prepare({ key });
    const claims = await Promise.allSettled([store.claimExternalOperation({ orderId: order.id, profileId: PROFILE_ID, operation: "customer" }),
      replica.claimExternalOperation({ orderId: order.id, profileId: PROFILE_ID, operation: "customer" })]);
    assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
    const token = claims.find((claim) => claim.status === "fulfilled").value;
    await store.finishExternalOperation({ orderId: order.id, operation: "customer", token, errorCode: "synthetic-response-loss" });
    const restarted = newStore(); await restarted.ensureSchema();
    await assert.rejects(() => restarted.claimExternalOperation({ orderId: order.id, profileId: PROFILE_ID, operation: "customer" }), { code: "payment_operation_already_started" });
    await assert.rejects(() => restarted.adminCancelUnpaidOrder(order.id), { code: "payment_reconciliation_required" });
    const [[claim]] = await db.query("SELECT payment_profile_id,state FROM galatic_external_operation_claims WHERE order_id=?", [order.id]);
    assert.deepEqual(claim, { payment_profile_id: PROFILE_ID, state: "uncertain" });
    assert.equal((await restarted.getOrderByPublicId(order.id)).profileId, PROFILE_ID);
    const local = (await prepare()).order;
    await db.query("DELETE FROM galatic_checkout_attempts WHERE order_id=?", [local.id]);
    await assert.rejects(() => restarted.adminCancelUnpaidOrder(local.id), { code: "payment_reconciliation_required" });
    await assert.rejects(() => restarted.claimExternalOperation({ orderId: local.id, profileId: PROFILE_ID, operation: "customer" }), { code: "payment_operation_not_dispatchable" });
    assert.equal((await restarted.getOrderByPublicId(local.id)).status, "pending");
    const safe = (await prepare()).order;
    assert.equal(await restarted.adminCancelUnpaidOrder(safe.id), true);
    await assert.rejects(() => restarted.claimExternalOperation({ orderId: safe.id, profileId: PROFILE_ID, operation: "customer" }), { code: "payment_operation_not_dispatchable" });
  });

  await t.test("T5/T10: final index cutover allows equal provider, group and event IDs without crossing profiles or mutating duplicate evidence", async () => {
    const secondId = "galatic-second";
    const secondIdentity = { ...identity, id: secondId, expectedWalletId: "22222222-2222-4222-8222-222222222222" };
    await store.registerPaymentProfileIdentity(secondIdentity, profileIdentityHash(secondIdentity));
    const keyA = randomUUID(), keyB = randomUUID();
    const first = (await prepare({ key: keyA, paymentMethod: "credit_card", installments: 2 })).order;
    const second = (await prepare({ key: keyB, profileId: secondId, paymentMethod: "credit_card", installments: 2 })).order;
    const pricing = (order) => ({ totalCents: order.totalCents, baseCents: order.totalCents, feeCents: 0, installmentCents: order.totalCents / 2 });
    for (const [key, order, profileId] of [[keyA, first, PROFILE_ID], [keyB, second, secondId]]) {
      await store.beginPaymentCreation(key, order.id, { profileId, customerId: `cus_${profileId}`, pricing: pricing(order) });
      await store.attachPayment(order.id, "pay_cross_profile", "processing", { profileId, providerGroupId: "ins_cross_profile", totalCents: order.totalCents });
    }
    const raw = createGalaticMySqlStore(databaseUrl); stores.push(raw); await raw.ensureSchema();
    await assert.rejects(() => raw.getOrderByProviderOrderId("asaas", "pay_cross_profile"), { code: "payment_profile_unknown" });
    assert.equal((await raw.getOrderByProviderOrderId("asaas", "pay_cross_profile", { profileId: PROFILE_ID })).id, first.id);
    assert.equal((await raw.getOrderByProviderOrderId("asaas", "pay_cross_profile", { profileId: secondId })).id, second.id);
    const firstEvent = { provider: "asaas", providerOrderId: "pay_cross_profile", providerGroupId: "ins_cross_profile", eventId: "evt_cross_profile",
      status: "paid", externalReference: `galatic:${first.id}`, paymentEvidence: { id: "pay_cross_profile", customer: `cus_${PROFILE_ID}`,
        billingType: "CREDIT_CARD", status: "CONFIRMED", installment: "ins_cross_profile", value: first.totalCents / 200, externalReference: `galatic:${first.id}` } };
    const otherEvent = { ...firstEvent, externalReference: `galatic:${second.id}`,
      paymentEvidence: { ...firstEvent.paymentEvidence, customer: `cus_${secondId}`, externalReference: `galatic:${second.id}` } };
    await raw.ingestAuthenticatedEvent({ profileId: PROFILE_ID, event: firstEvent });
    await raw.ingestAuthenticatedEvent({ profileId: secondId, event: otherEvent });
    assert.equal((await raw.getOrderByPublicId(first.id)).status, "processing", "receipt alone is not complete group proof");
    await raw.updateOrderFromWebhook({ ...firstEvent, profileId: PROFILE_ID, completeGroupProof: true });
    assert.equal((await raw.getOrderByPublicId(first.id)).status, "paid");
    assert.equal((await raw.getOrderByPublicId(second.id)).status, "processing");
    await raw.ingestAuthenticatedEvent({ profileId: secondId, event: { ...otherEvent, externalReference: `galatic:${first.id}`, status: "refunded" } });
    const [events] = await db.query("SELECT payment_namespace,external_reference,status FROM galatic_payment_events WHERE event_id='evt_cross_profile' ORDER BY payment_namespace");
    assert.equal(events.length, 2); assert.ok(events.some((event) => event.external_reference === `galatic:${second.id}` && event.status === "paid"));
    await raw.updateOrderFromWebhook({ ...otherEvent, profileId: secondId, completeGroupProof: true });
    assert.equal((await raw.getOrderByPublicId(second.id)).status, "paid");
    const wrong = await raw.updateOrderFromWebhook({ ...firstEvent, profileId: secondId, eventId: "evt_wrong_profile_reference", completeGroupProof: true });
    assert.equal(wrong.id, null); assert.equal((await raw.getOrderByPublicId(first.id)).status, "paid");
    await raw.ingestAuthenticatedEvent({ profileId: PROFILE_ID, event: { ...firstEvent, eventId: "evt_legacy_expand" } });
    await raw.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_legacy_expand", status: "refunded", eventId: "evt_legacy_expand" });
    const [legacyDuplicates] = await db.query("SELECT payment_namespace,status FROM galatic_payment_events WHERE event_id='evt_legacy_expand' ORDER BY payment_namespace");
    assert.equal(legacyDuplicates.length, 2); assert.ok(legacyDuplicates.some((event) => event.payment_namespace === "legacy" && event.status === "paid"));
    const [pk] = await db.query("SELECT COLUMN_NAME col FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='galatic_payment_events' AND INDEX_NAME='PRIMARY'");
    assert.deepEqual(pk.map((row) => row.col), ["internal_event_id"]);
    const [globalUnique] = await db.query("SELECT INDEX_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='galatic_orders' AND INDEX_NAME='payment_provider_order_id'");
    assert.equal(globalUnique.length, 0);
    await prepare(); await prepare(); await prepare({ profileId: secondId });
    const fairBatch = await raw.listExpiredPaymentReservations({ pixBefore: new Date(Date.now() + 60_000), cardBefore: new Date(Date.now() + 60_000), limit: 2 });
    assert.equal(fairBatch.length, 2); assert.equal(new Set(fairBatch.map((row) => row.profileId)).size, 2);
    assert.ok(fairBatch.every((row) => row.profileId));
  });

  await t.test("T10: reviewed legacy binding preserves financial facts, uses CAS and cannot assign original action provenance", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    await store.beginPaymentCreation(key, order.id, { customerId: "cus_legacy", pricing: { totalCents: order.totalCents } });
    await store.attachPayment(order.id, "pay_legacy_review", "paid", { totalCents: order.totalCents });
    await db.query("UPDATE galatic_orders SET payment_profile_id=NULL,payment_namespace='legacy',binding_version=0 WHERE id=?", [order.id]);
    await db.query("UPDATE galatic_checkout_attempts SET payment_profile_id=NULL,payment_namespace='legacy',binding_version=0 WHERE order_id=?", [order.id]);
    await db.query("INSERT INTO galatic_payment_actions(order_id,action,state,provider_reference,admin_id) VALUES (?,'refund','uncertain','pay_legacy_review','synthetic-reviewer')", [order.id]);
    const [[before]] = await db.query("SELECT * FROM galatic_orders WHERE id=?", [order.id]);
    const ledgerEntry = { entityType: "order", entityKey: { id: order.id }, profileId: PROFILE_ID,
      fingerprint: legacyBindingFingerprint("order", before), expectedVersion: 0, externalEvidence: "synthetic-exact-account-reference-evidence",
      reviewState: "approved", reviewedBy: "synthetic-reviewer" };
    const staleId = await store.addReviewedLegacyBinding(ledgerEntry);
    await db.query("UPDATE galatic_orders SET total_cents=total_cents+1 WHERE id=?", [order.id]);
    await assert.rejects(() => store.applyLegacyBindingCAS(staleId), { code: "binding_compare_and_set_conflict" });
    await db.query("UPDATE galatic_orders SET total_cents=total_cents-1 WHERE id=?", [order.id]);
    const [[reviewedAgain]] = await db.query("SELECT * FROM galatic_orders WHERE id=?", [order.id]);
    const approvedId = await store.addReviewedLegacyBinding({ ...ledgerEntry, fingerprint: legacyBindingFingerprint("order", reviewedAgain) });
    await store.applyLegacyBindingCAS(approvedId);
    await assert.rejects(() => store.applyLegacyBindingCAS(approvedId), { code: "binding_review_invalid" });
    const [[after]] = await db.query("SELECT * FROM galatic_orders WHERE id=?", [order.id]);
    for (const field of ["payment_provider_order_id", "payment_provider_group_id", "payment_status", "subtotal_cents", "shipping_cents", "total_cents", "paid_at", "stock_released_at", "fulfillment_status"]) assert.deepEqual(after[field], before[field], field);
    assert.equal(after.payment_profile_id, PROFILE_ID); assert.equal(after.binding_version, 1);
    const [[audit]] = await db.query("SELECT COUNT(*) total FROM galatic_payment_binding_audit WHERE ledger_id=?", [approvedId]); assert.equal(audit.total, 1);
    const [[action]] = await db.query("SELECT payment_profile_id,snapshot_json FROM galatic_payment_actions WHERE order_id=?", [order.id]);
    assert.deepEqual(action, { payment_profile_id: null, snapshot_json: null });
    assert.equal((await store.claimRefund(order.id, "synthetic-reviewer")).claimed, false);
    const raw = createGalaticMySqlStore(databaseUrl); stores.push(raw);
    await assert.rejects(() => raw.getCheckoutRecovery({ orderId: order.id }), { code: "payment_profile_binding_conflict" });
    const [[history]] = await db.query("SELECT * FROM galatic_payment_actions WHERE order_id=?", [order.id]);
    await assert.rejects(() => store.addReviewedLegacyBinding({ ...ledgerEntry, entityType: "action", entityKey: { order_id: order.id, action: "refund" },
      fingerprint: legacyBindingFingerprint("action", history) }), { code: "binding_action_snapshot_required" });
    const actionSnapshot = { id: order.id, profileId: PROFILE_ID, providerReference: "pay_legacy_review", referenceKind: "payment",
      providerOrderId: "pay_legacy_review", providerGroupId: null, providerCustomerId: "cus_legacy", method: "pix", installments: 1,
      totalCents: order.totalCents, pricing: { totalCents: order.totalCents } };
    const actionLedger = await store.addReviewedLegacyBinding({ ...ledgerEntry, entityType: "action", entityKey: { order_id: order.id, action: "refund" },
      fingerprint: legacyBindingFingerprint("action", history), actionSnapshot });
    await store.applyLegacyBindingCAS(actionLedger);
    assert.equal((await store.claimRefund(order.id, "synthetic-reviewer")).claimed, false, "reviewing original dispatch never permits a resend");
    const [[boundAction]] = await db.query("SELECT payment_profile_id,reference_kind,state,snapshot_json FROM galatic_payment_actions WHERE order_id=?", [order.id]);
    assert.equal(boundAction.payment_profile_id, PROFILE_ID); assert.equal(boundAction.reference_kind, "payment"); assert.equal(boundAction.state, "uncertain");
    assert.equal((typeof boundAction.snapshot_json === "string" ? JSON.parse(boundAction.snapshot_json) : boundAction.snapshot_json).providerOrderId, "pay_legacy_review");
  });

  await t.test("T3: a full connection pool of concurrent reservations settles without nested pool acquisition", async () => {
    await db.query("UPDATE galatic_products SET stock_quantity=100 WHERE sku='TEST01'");
    const quoteIds = await Promise.all(Array.from({ length: 12 }, () => quote()));
    let timeout;
    try {
      const results = await Promise.race([Promise.allSettled(quoteIds.map((quoteId) => prepare({ quoteId }))),
        new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("reservation_pool_deadlock")), 8000); })]);
      assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.kind === "created").length, 12,
        results.filter((result) => result.status === "rejected").map((result) => result.reason.code).join(","));
      const [[stock]] = await db.query("SELECT stock_quantity FROM galatic_products WHERE sku='TEST01'"); assert.equal(stock.stock_quantity, 88);
      const [quotes] = await db.query(`SELECT status FROM galatic_shipping_quotes WHERE id IN (${quoteIds.map(() => "?").join(",")})`, quoteIds);
      assert.ok(quotes.every((row) => row.status === "consumed"));
    } finally { clearTimeout(timeout); }
  });

  await t.test("T5/T11: fifty contradictory receipts cannot starve a later valid receipt in the same profile after restart", async () => {
    const key = randomUUID(); const { order } = await prepare({ key });
    const evidence = { id: "pay_receipt_fairness", customer: "cus_synthetic", billingType: "PIX", status: "CONFIRMED", value: order.totalCents / 100,
      externalReference: `galatic:${order.id}` };
    await store.beginPaymentCreation(key, order.id, { customerId: evidence.customer, pricing: { totalCents: order.totalCents } });
    await store.attachPayment(order.id, evidence.id, "open", { totalCents: order.totalCents });
    for (let index = 0; index < 50; index += 1) await store.ingestAuthenticatedEvent({ profileId: PROFILE_ID, event: {
      provider: "asaas", providerOrderId: evidence.id, eventId: `evt_receipt_fair_old_${index}`, status: "canceled", externalReference: evidence.externalReference,
      paymentEvidence: { ...evidence, status: "CANCELED" } } });
    await db.query("UPDATE galatic_payment_events SET received_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE event_id LIKE 'evt_receipt_fair_old_%'");
    await store.ingestAuthenticatedEvent({ profileId: PROFILE_ID, event: { provider: "asaas", providerOrderId: evidence.id,
      eventId: "evt_receipt_fair_valid", status: "paid", externalReference: evidence.externalReference, paymentEvidence: evidence } });
    const reconcile = createGalaticDeferredEventReconciliation({ store, paymentProfiles: syntheticProfiles(store, { getPayment: async () => evidence }),
      financialGate: createGalaticFinancialGate({ enabled: true }) });
    const first = await reconcile({ profileId: PROFILE_ID, orderId: order.id, limit: 50 });
    assert.equal(first.inspected, 50); assert.equal(first.applied, 0); assert.equal(first.pending, 50);
    const restarted = newStore(); await restarted.ensureSchema();
    const next = createGalaticDeferredEventReconciliation({ store: restarted, paymentProfiles: syntheticProfiles(restarted, { getPayment: async () => evidence }),
      financialGate: createGalaticFinancialGate({ enabled: true }) });
    assert.equal((await next({ profileId: PROFILE_ID, orderId: order.id, limit: 50 })).applied, 1);
    assert.equal((await restarted.getOrderByPublicId(order.id)).status, "paid");
    const [[old]] = await db.query("SELECT COUNT(*) total,MIN(reconciliation_attempts) attempts FROM galatic_payment_events WHERE event_id LIKE 'evt_receipt_fair_old_%' AND applied_at IS NULL AND status='canceled'");
    assert.equal(old.total, 50); assert.equal(old.attempts, 1);
    assert.ok((await db.query("SELECT applied_at FROM galatic_payment_events WHERE event_id='evt_receipt_fair_valid'"))[0][0].applied_at);
  });
});
