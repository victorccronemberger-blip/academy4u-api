import { createHash, randomUUID } from "node:crypto";
import { paymentNamespace, paymentProfileError } from "../services/galatic-payment-profiles.js";

const TABLES = ["galatic_orders", "galatic_checkout_attempts", "galatic_payment_actions", "galatic_payment_action_attempts", "galatic_payment_events"];
const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
const TARGETS = Object.freeze({
  order: { table: "galatic_orders", keys: ["id"], facts: ["id", "payment_provider", "payment_provider_order_id", "payment_provider_group_id", "payment_status", "total_cents", "binding_version"] },
  attempt: { table: "galatic_checkout_attempts", keys: ["idempotency_key"], facts: ["idempotency_key", "order_id", "request_fingerprint", "state", "provider_customer_id", "pricing_json", "binding_version"] },
  action: { table: "galatic_payment_actions", keys: ["order_id", "action"], facts: ["order_id", "action", "state", "provider_reference", "attempt_version", "binding_version"] },
  actionAttempt: { table: "galatic_payment_action_attempts", keys: ["order_id", "action", "attempt_version"], facts: ["order_id", "action", "state", "provider_reference", "attempt_version", "binding_version"] },
  event: { table: "galatic_payment_events", keys: ["internal_event_id"], facts: ["internal_event_id", "event_id", "provider", "provider_order_id", "provider_group_id", "status", "external_reference", "binding_version"] },
});
export function legacyBindingFingerprint(entityType, row) {
  const target = TARGETS[entityType];
  if (!target) throw paymentProfileError("binding_entity_invalid");
  const canonical = (value) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return new Date(value.replace(" ", "T") + "Z").toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  };
  const normalized = Object.fromEntries(Object.keys(row).sort().map((key) => {
    const value = key.endsWith("_json") && typeof row[key] === "string" ? parse(row[key]) : row[key];
    return [key, canonical(value)];
  }));
  // Hash the complete row, including money, reservation/history timestamps and
  // workflow metadata. Only the digest is retained in the review ledger.
  return createHash("sha256").update(JSON.stringify([entityType, normalized])).digest("hex");
}
export async function expandPaymentProfileSchema(pool) {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS galatic_payment_profiles (id VARCHAR(64) PRIMARY KEY, identity_hash CHAR(64) NOT NULL,
      identity_json JSON NOT NULL, capabilities_json JSON NULL, commercial_approved TINYINT NOT NULL DEFAULT 0,
      approval_evidence VARCHAR(200) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS galatic_external_operation_claims (order_id CHAR(36) NOT NULL, operation VARCHAR(24) NOT NULL,
      payment_profile_id VARCHAR(64) NOT NULL, claim_token CHAR(36) NOT NULL, state VARCHAR(24) NOT NULL DEFAULT 'claimed',
      provider_reference VARCHAR(80) NULL, error_code VARCHAR(100) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(order_id,operation))`,
    `CREATE TABLE IF NOT EXISTS galatic_legacy_binding_ledger (id CHAR(36) PRIMARY KEY, entity_type VARCHAR(24) NOT NULL,
      entity_key_json JSON NOT NULL, profile_id VARCHAR(64) NOT NULL, fingerprint CHAR(64) NOT NULL,
      expected_version INT NOT NULL, reviewed_snapshot_json JSON NULL, external_evidence VARCHAR(200) NOT NULL, review_state VARCHAR(24) NOT NULL,
      reviewed_by VARCHAR(100) NOT NULL, applied_at DATETIME(3) NULL)`,
    `CREATE TABLE IF NOT EXISTS galatic_payment_binding_audit (id CHAR(36) PRIMARY KEY, ledger_id CHAR(36) NOT NULL UNIQUE,
      entity_type VARCHAR(24) NOT NULL, entity_key_json JSON NOT NULL, profile_id VARCHAR(64) NOT NULL,
      fingerprint CHAR(64) NOT NULL, bound_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
  ]) await pool.query(statement);
  for (const table of TABLES) {
    for (const [column, definition] of [
      ["payment_profile_id", "VARCHAR(64) NULL"], ["payment_namespace", "VARCHAR(80) NOT NULL DEFAULT 'legacy'"],
      ["binding_version", "INT NOT NULL DEFAULT 0"],
      ...(table === "galatic_payment_events" ? [["internal_event_id", "CHAR(36) NULL"], ["reconciliation_attempts", "INT NOT NULL DEFAULT 0"], ["reconcile_after", "DATETIME(3) NULL"]] : []),
      ...(table.includes("payment_action") ? [["reference_kind", "VARCHAR(24) NULL"], ["snapshot_json", "JSON NULL"]] : []),
    ]) {
      const [[existing]] = await pool.query("SELECT 1 present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?", [table, column]);
      if (!existing) try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
      catch (error) { if (error.code !== "ER_DUP_FIELDNAME") throw error; }
    }
  }
  await pool.query("UPDATE galatic_payment_events SET internal_event_id=UUID() WHERE internal_event_id IS NULL");
  for (const [table, name, columns] of [
    ["galatic_orders", "galatic_orders_profile_provider", "payment_namespace,payment_provider_order_id"],
    ["galatic_payment_events", "galatic_events_profile_event", "payment_namespace,event_id"],
    ["galatic_payment_events", "galatic_events_internal", "internal_event_id"],
  ]) {
    const [[existing]] = await pool.query("SELECT 1 present FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?", [table, name]);
    if (!existing) try { await pool.query(`CREATE UNIQUE INDEX ${name} ON ${table} (${columns})`); }
    catch (error) { if (error.code !== "ER_DUP_KEYNAME") throw error; }
  }
}

// Deliberately excluded from ensureSchema and startup. DDL auto-commits; each
// step is resumable, with the activation marker written only after validation.
export async function cutoverPaymentProfileIndexes(pool, evidence) {
  if (evidence?.allInstancesEnumerated !== true || evidence?.oldProcessesTerminated !== true
    || evidence?.bareAndWwwCovered !== true || evidence?.independentJobsCovered !== true
    || evidence?.financialGateFalse !== true || evidence?.zeroInflight !== true
    || !/^[a-f0-9]{40}$/.test(evidence?.stageARevision ?? "") || !evidence?.evidenceReference) {
    throw paymentProfileError("payment_profile_drain_not_proven");
  }
  for (const [table, name] of [["galatic_orders", "galatic_orders_profile_provider"], ["galatic_payment_events", "galatic_events_profile_event"], ["galatic_payment_events", "galatic_events_internal"]]) {
    const [[index]] = await pool.query("SELECT 1 present FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? AND NON_UNIQUE=0", [table, name]);
    if (!index) throw paymentProfileError("payment_profile_expansion_required");
  }
  const [indexes] = await pool.query(`SELECT INDEX_NAME name,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='galatic_orders'
    AND NON_UNIQUE=0 GROUP BY INDEX_NAME`);
  for (const index of indexes) if (index.cols === "payment_provider_order_id") {
    if (!/^[A-Za-z0-9_]+$/.test(index.name)) throw new Error("invalid_index_name");
    await pool.query(`ALTER TABLE galatic_orders DROP INDEX \`${index.name}\``);
  }
  const [primary] = await pool.query("SELECT COLUMN_NAME col FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='galatic_payment_events' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX");
  if (primary.length !== 1 || primary[0].col !== "internal_event_id") {
    await pool.query("ALTER TABLE galatic_payment_events MODIFY internal_event_id CHAR(36) NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY(internal_event_id)");
  }
  await pool.query(`INSERT INTO galatic_schema_migrations (migration_key,completed_at,details)
    VALUES ('payment_profiles_namespaced_v1',UTC_TIMESTAMP(3),?) ON DUPLICATE KEY UPDATE details=VALUES(details)`,
    [String(evidence.evidenceReference).slice(0, 255)]);
}

export function createPaymentProfileStore(pool, ensureSchema) {
  return {
    async registerPaymentProfileIdentity(identity, hash) {
      await ensureSchema();
      await pool.query("INSERT IGNORE INTO galatic_payment_profiles (id,identity_hash,identity_json) VALUES (?,?,?)", [identity.id, hash, JSON.stringify(identity)]);
      const [[row]] = await pool.query("SELECT identity_hash FROM galatic_payment_profiles WHERE id=?", [identity.id]);
      if (row?.identity_hash !== hash) throw paymentProfileError("payment_profile_identity_conflict");
    },
    async getPaymentProfileAuthorization(id) {
      await ensureSchema();
      const [[row]] = await pool.query("SELECT capabilities_json,commercial_approved,approval_evidence FROM galatic_payment_profiles WHERE id=?", [id]);
      return { capabilities: parse(row?.capabilities_json) ?? [], commercialApproved: row?.commercial_approved === 1, evidenceReference: row?.approval_evidence ?? null };
    },
    async assertPaymentProfileDispatchPhase(executor = pool) {
      await ensureSchema();
      const [[marker]] = await executor.query("SELECT completed_at FROM galatic_schema_migrations WHERE migration_key='payment_profiles_namespaced_v1'");
      if (!marker?.completed_at) throw paymentProfileError("payment_profile_cutover_required");
    },
    async claimExternalOperation({ orderId, profileId, operation }) {
      await ensureSchema();
      if (!["customer", "payment"].includes(operation) || !profileId) throw paymentProfileError("payment_operation_invalid");
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[row]] = await connection.query("SELECT payment_profile_id,payment_status FROM galatic_orders WHERE id=? FOR UPDATE", [orderId]);
        if (row?.payment_profile_id !== profileId) throw paymentProfileError("payment_profile_binding_conflict");
        const [[attempt]] = await connection.query("SELECT payment_profile_id,operation_version,state FROM galatic_checkout_attempts WHERE order_id=? FOR UPDATE", [orderId]);
        if (!attempt || attempt.payment_profile_id !== profileId || Number(attempt.operation_version) !== 1
          || attempt.state !== (operation === "customer" ? "pending" : "creating")
          || !["pending", "open", "processing", "overdue"].includes(row.payment_status)) throw paymentProfileError("payment_operation_not_dispatchable");
        const token = randomUUID();
        const [result] = await connection.query(`INSERT IGNORE INTO galatic_external_operation_claims
          (order_id,operation,payment_profile_id,claim_token) VALUES (?,?,?,?)`, [orderId, operation, profileId, token]);
        if (!result.affectedRows) throw paymentProfileError("payment_operation_already_started");
        await connection.commit(); return token;
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async finishExternalOperation({ orderId, operation, token, providerReference = null, errorCode = null }) {
      await ensureSchema();
      await pool.query(`UPDATE galatic_external_operation_claims SET state=?,provider_reference=?,error_code=?
        WHERE order_id=? AND operation=? AND claim_token=? AND state='claimed'`,
        [errorCode ? "uncertain" : "completed", providerReference, errorCode, orderId, operation, token]);
    },
    async claimBoundAction({ orderId, adminId, kind, expectedVersion = null }) {
      await ensureSchema();
      if (!["cancel", "refund"].includes(kind)) throw paymentProfileError("payment_action_invalid");
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[order]] = await connection.query(`SELECT o.*,a.provider_customer_id,a.pricing_json,a.payment_profile_id attempt_profile_id,a.operation_version
          FROM galatic_orders o LEFT JOIN galatic_checkout_attempts a ON a.order_id=o.id WHERE o.id=? FOR UPDATE`, [orderId]);
        if (!order?.payment_profile_id) throw paymentProfileError("payment_profile_unknown");
        if (expectedVersion !== null && order.binding_version !== expectedVersion) throw paymentProfileError("payment_action_version_conflict");
        if ((kind === "refund" && order.payment_status !== "paid")
          || (kind === "cancel" && ["paid", "refunded", "chargeback"].includes(order.payment_status))) throw paymentProfileError("payment_action_state_conflict");
        const [[existing]] = await connection.query("SELECT * FROM galatic_payment_actions WHERE order_id=? AND action=? FOR UPDATE", [orderId, kind]);
        if (existing && (existing.state !== "rejected" || !existing.payment_profile_id || !existing.snapshot_json)) {
          await connection.commit(); return { claimed: false, state: existing.state, version: existing.attempt_version };
        }
        if (order.attempt_profile_id !== order.payment_profile_id || Number(order.operation_version) !== 1) throw paymentProfileError("payment_profile_evidence_missing");
        const reference = order.payment_provider_group_id || order.payment_provider_order_id;
        if (!reference || !order.provider_customer_id || !order.pricing_json) throw paymentProfileError("payment_action_evidence_missing");
        const version = existing ? existing.attempt_version + 1 : 1;
        const referenceKind = order.payment_provider_group_id ? "installment" : "payment";
        const snapshot = { id: order.id, profileId: order.payment_profile_id, providerOrderId: order.payment_provider_order_id,
          providerGroupId: order.payment_provider_group_id, installments: Number(order.installments), method: order.payment_method,
          totalCents: Number(order.total_cents), providerCustomerId: order.provider_customer_id, pricing: parse(order.pricing_json) };
        await connection.query(`INSERT INTO galatic_payment_actions
          (order_id,action,state,provider_reference,reference_kind,snapshot_json,payment_profile_id,payment_namespace,binding_version,admin_id,attempt_version)
          VALUES (?,?,'in_progress',?,?,?,?,?,1,?,?) ON DUPLICATE KEY UPDATE state='in_progress',provider_reference=VALUES(provider_reference),
          reference_kind=VALUES(reference_kind),snapshot_json=VALUES(snapshot_json),payment_profile_id=VALUES(payment_profile_id),
          payment_namespace=VALUES(payment_namespace),admin_id=VALUES(admin_id),attempt_version=VALUES(attempt_version),error_code=NULL,
          reconcile_after=NULL,created_at=UTC_TIMESTAMP(3)`,
          [orderId, kind, reference, referenceKind, JSON.stringify(snapshot), order.payment_profile_id, paymentNamespace(order.payment_profile_id), adminId, version]);
        await connection.query(`INSERT INTO galatic_payment_action_attempts
          (order_id,action,attempt_version,state,provider_reference,reference_kind,snapshot_json,payment_profile_id,payment_namespace,binding_version,admin_id)
          VALUES (?,?,?,'in_progress',?,?,?,?,?,1,?)`,
          [orderId, kind, version, reference, referenceKind, JSON.stringify(snapshot), order.payment_profile_id, paymentNamespace(order.payment_profile_id), adminId]);
        await connection.commit(); return { claimed: true, ...snapshot, providerReference: reference, referenceKind,
          group: referenceKind === "installment", version };
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async finishCancellationRequest(orderId, profileId, version, state) {
      await ensureSchema();
      if (!["completed", "uncertain"].includes(state)) throw paymentProfileError("payment_action_state_invalid");
      await pool.query(`UPDATE galatic_payment_actions SET state=? WHERE order_id=? AND action='cancel'
        AND payment_profile_id=? AND attempt_version=? AND state='in_progress'`, [state, orderId, profileId, version]);
      await pool.query(`UPDATE galatic_payment_action_attempts SET state=? WHERE order_id=? AND action='cancel'
        AND payment_profile_id=? AND attempt_version=? AND state='in_progress'`, [state, orderId, profileId, version]);
    },
    async addReviewedLegacyBinding(entry) {
      await ensureSchema();
      const target = TARGETS[entry.entityType];
      if (!target || entry.reviewState !== "approved" || !entry.reviewedBy || !entry.externalEvidence
        || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !Number.isInteger(entry.expectedVersion)
        || Object.keys(entry.entityKey ?? {}).sort().join() !== [...target.keys].sort().join()) throw paymentProfileError("binding_review_invalid");
      paymentNamespace(entry.profileId);
      if (entry.entityType === "action" || entry.entityType === "actionAttempt") {
        const snapshot = entry.actionSnapshot;
        if (!snapshot || snapshot.profileId !== entry.profileId || snapshot.id !== entry.entityKey.order_id
          || !["payment", "installment"].includes(snapshot.referenceKind) || !snapshot.providerReference
          || snapshot.providerReference !== (snapshot.referenceKind === "installment" ? snapshot.providerGroupId : snapshot.providerOrderId)
          || !snapshot.providerCustomerId || !Number.isSafeInteger(snapshot.pricing?.totalCents)
          || !Number.isInteger(snapshot.installments) || snapshot.installments < 1 || snapshot.installments > 10) {
          throw paymentProfileError("binding_action_snapshot_required");
        }
      }
      const id = randomUUID();
      await pool.query(`INSERT INTO galatic_legacy_binding_ledger
        (id,entity_type,entity_key_json,profile_id,fingerprint,expected_version,reviewed_snapshot_json,external_evidence,review_state,reviewed_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, entry.entityType, JSON.stringify(entry.entityKey), entry.profileId, entry.fingerprint,
        entry.expectedVersion, entry.actionSnapshot ? JSON.stringify(entry.actionSnapshot) : null, entry.externalEvidence, entry.reviewState, entry.reviewedBy]);
      return id;
    },
    async applyLegacyBindingCAS(ledgerEntryId) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[entry]] = await connection.query("SELECT * FROM galatic_legacy_binding_ledger WHERE id=? FOR UPDATE", [ledgerEntryId]);
        if (!entry || entry.review_state !== "approved" || entry.applied_at) throw paymentProfileError("binding_review_invalid");
        const target = TARGETS[entry.entity_type]; const keys = parse(entry.entity_key_json);
        const predicate = target.keys.map((key) => `${key}=?`).join(" AND "); const values = target.keys.map((key) => keys[key]);
        const [[row]] = await connection.query(`SELECT * FROM ${target.table} WHERE ${predicate} FOR UPDATE`, values);
        if (!row || row.payment_profile_id !== null || row.binding_version !== entry.expected_version
          || legacyBindingFingerprint(entry.entity_type, row) !== entry.fingerprint) throw paymentProfileError("binding_compare_and_set_conflict");
        const reviewedSnapshot = parse(entry.reviewed_snapshot_json);
        if ((entry.entity_type === "action" || entry.entity_type === "actionAttempt")
          && (!reviewedSnapshot || reviewedSnapshot.providerReference !== row.provider_reference)) throw paymentProfileError("binding_action_snapshot_required");
        const [[profile]] = await connection.query("SELECT id FROM galatic_payment_profiles WHERE id=?", [entry.profile_id]);
        if (!profile) throw paymentProfileError("payment_profile_unknown");
        await connection.query(`UPDATE ${target.table} SET payment_profile_id=?,payment_namespace=?,binding_version=binding_version+1
          WHERE ${predicate} AND payment_profile_id IS NULL AND binding_version=?`, [entry.profile_id, paymentNamespace(entry.profile_id), ...values, entry.expected_version]);
        if (reviewedSnapshot) await connection.query(`UPDATE ${target.table} SET snapshot_json=?,reference_kind=? WHERE ${predicate}`,
          [JSON.stringify(reviewedSnapshot), reviewedSnapshot.referenceKind, ...values]);
        await connection.query(`INSERT INTO galatic_payment_binding_audit (id,ledger_id,entity_type,entity_key_json,profile_id,fingerprint)
          VALUES (?,?,?,?,?,?)`, [randomUUID(), entry.id, entry.entity_type, JSON.stringify(keys), entry.profile_id, entry.fingerprint]);
        await connection.query("UPDATE galatic_legacy_binding_ledger SET applied_at=UTC_TIMESTAMP(3) WHERE id=?", [entry.id]);
        await connection.commit(); return true;
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
  };
}
