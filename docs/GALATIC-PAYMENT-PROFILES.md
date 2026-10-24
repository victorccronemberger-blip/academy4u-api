# Galatic payment profiles

Stage B is a Galatic-only immutable provenance migration. Academy4u keeps its existing client, checkout aliases, LMS runtime token/hash configuration, installment/access callbacks and ART startup. Galatic never inherits the Academy Asaas key, origin, environment or webhook credential. The legacy webhook credential is used only to authenticate a retriable 503 on the old Galatic path.

## Configuration and authorization

`GALATIC_PAYMENT_PROFILES_JSON` is a JSON array. Each entry contains `id`, `provider: "asaas"`, `environment: "sandbox" | "production"`, `expectedWalletId`, `allowedTenants: ["galatic"]`, `apiKeyEnv`, and `webhookTokenEnv`. Optional `previousWebhookTokenEnv` supports webhook rotation within that same profile. Credential variable names must start with `GALATIC_`. Secret values exist only in the server environment. API origins are fixed in source. Never copy the Academy credential into a Galatic variable.

`GALATIC_DEFAULT_PAYMENT_PROFILE_ID` selects genuinely new checkout keys only. A completed replay returns the original stored response; a pending replay reconciles its original profile. Changing account, environment, provider or tenant requires a new profile ID. Persisted identity metadata refuses ID reuse. Same-wallet key rotation creates a new immutable SDK generation after process replacement without changing old order bindings. Caches include the generation.

All profile capabilities begin denied in `galatic_payment_profiles.capabilities_json`. The explicit capabilities are `checkout`, `read`, `recovery`, `cancel`, `refund`, `webhook`, and `fulfillment`. Production additionally requires a recorded commercial review and evidence reference in the profile authorization row. An environment variable or successful HTTP response cannot grant this approval. Provisioning reviewed authorizations is an operator process; there is no public or admin approval toggle.

New checkout also requires a captured exclusive webhook credential. Missing webhook credentials block new orders before reservation, while explicitly authorized historical read/recovery capabilities may remain available through the bound account. Injecting a token into a mutable source after startup does not change the captured profile.

The immutable Stage A financial guard remains closed unless the captured raw value of `GALATIC_FINANCIAL_OPERATIONS_ENABLED` is exactly string `true`. No wallet request occurs at startup, readiness or verification with the guard closed. Sales remain a separate gate. A configured profile is not evidence of an active legal merchant, suppliers, fiscal readiness or logistics acceptance.

## Verification and expiry

The registry verifies GET `/v3/wallets/`, requiring a list with exactly one wallet, `hasMore: false`, `totalCount: 1`, `offset: 0`, a positive integer limit, a valid UUID and an exact match to the pinned wallet. Multiple wallets, incomplete pagination, mismatches and malformed responses fail closed. Verification expires after 15 minutes. Every SDK call rechecks the guard, TTL, persisted capability, production review and schema phase, including calls made through a previously obtained client.

An authenticated owner may renew identity using POST `/v1/galatic/admin/payment-profiles/:id/verify` with an empty JSON body. This route requires the financial guard and does not alter credentials, profile identity, capabilities or merchant approval. Expired profiles remain blocked until successful explicit verification; no automatic financial request is retried to restore them. Verification authenticates the wallet only and is not legal/CNPJ approval.

## Durable bindings and uncertain writes

Orders, checkout attempts, actions, action attempts and events carry nullable `payment_profile_id`, reserved `legacy` or unambiguous `profile:<id>` namespace, and a binding version. Existing NULL bindings remain unknown. Account/catalog/customer/history/mail functions remain available when profiles are missing or fail verification. Public status reports `profileStatus`, `paymentEnvironment`, `checkoutAvailable`, and the scope of a recorded operational review. Missing or invalid configuration reports a null payment environment.

Profile resolution, verification and schema-phase checks precede inventory reservation. Order, checkout attempt, quote consumption and stock reservation commit together. Customer POST and payment POST have separate durable, unique external-operation claims. A timeout, response loss, process replacement or lease expiry never permits an automatic second POST. Customer uncertainty conservatively retains the reservation; a customer claim alone is not evidence of a charge.

Local cancellation without a provider reference requires a present, matching-profile version-1 attempt in `pending`, with no customer or payment dispatch claim. Missing metadata cannot prove that no write occurred. Cancellation of an attached payment claims an immutable action and requires explicit unpaid evidence for every matching group member before DELETE. 404, unknown state, malformed evidence, contradictory anchor/group snapshots and unconfirmed DELETE responses preserve status and stock.

Actions snapshot the profile, payment/group reference, reference kind, customer, value, method and installment count. Dispatch and polling resolve that snapshot. Full refund completion requires complete pagination, unique IDs, exact customer/reference/group/value and agreement between the anchor GET and its group member. A single refunded installment or a foreign all-refunded list cannot complete a group. Attempt versions and completed state prevent late results from downgrading an operation. The historical `refund_operation` authorization indication remains attributed to the refund POST response.

Production labels require the bound approved production profile and current complete paid evidence with no reversals before shipment claim. The profile authorization is checked again before the label POST. Sandbox/local paid state and unresolved legacy rows cannot authorize a production label.

## Webhooks

Use `/v1/webhooks/asaas/profiles/:profileId`. The path is a hint: exclusive profile credentials authenticate before body inspection, inbox writes or deduplication. Shared tokens across profiles or with the Academy credential/hash invalidate configuration. Previous and current tokens may overlap only within one profile. The tenant allowlist and stored profile must agree.

The profile inbox preserves authenticated early receipts and immutable duplicate evidence in its namespace. Receipt alone does not establish a complete installment outcome. Current bound payment proof is reconciled before application; unmatched/early receipts remain durable for reconciliation. The old `/v1/webhooks/asaas` continues Academy compatibility; authenticated Galatic arrivals return retriable 503 and are not acknowledged as consumed or autoassigned.

`attachPayment` never financially replays a receipt. The shared deferred-event coordinator performs provider reads after SQL transactions and locks are released, from webhook processing, checkout/recovery after attachment and the worker. It applies only a receipt coherent with the current complete bound proof; contradictory evidence remains pending and immutable. Initial POST responses, recovery lists and current proof share the same structural/status validator. Canceled/deleted/unknown status, object IDs, nonzero offsets and malformed metadata cannot attach, complete checkout or release stock.

Pending receipt selection durably claims each event with a compare-and-set due time and increments its reconciliation counter before provider reads. A five-minute lease/backoff and per-profile attempt ordering advance inconclusive events without changing their payload, original status or identity. A permanently contradictory batch cannot starve a later valid event in that profile, including after process replacement.

## Migration and rollback gates

`ensureSchema` only expands the schema and adds namespace indexes. It preserves the existing global payment unique index and event primary key. It never performs the destructive cutover or assigns a current default to history. Until the explicit `payment_profiles_namespaced_v1` phase completes, new-profile dispatch and reservation fail closed.

`scripts/cutover-payment-profiles.mjs` is an operator-only path. It requires a dedicated `GALATIC_PROFILE_MIGRATION_MYSQL_URL`, a closed financial guard and `--reviewed-drain-evidence=<path>`. Evidence must cover all app/job instances, the exact Stage A revision, false guard, zero in-flight operations, bare/www topology, independent jobs and explicit termination of old processes. New health responses, startup counters, elapsed time and successful deployment do not prove a drain. It checks expansion indexes before removing the old global unique index and replacing the event primary key with the internal event ID. The final activation marker is written last, so interrupted DDL remains closed and resumable.

**The production drain has not been proven. Production cutover, credential changes and financial activation remain blocked.** Source implementation and disposable MySQL acceptance do not authorize production DDL. Do not stop or restart all hosting-account processes to obtain evidence while Academy is active.

Reviewed legacy bindings use `addReviewedLegacyBinding` and `applyLegacyBindingCAS`: exact entity key, profile, immutable-facts fingerprint, expected binding version, external evidence, approved review and reviewer. The transaction binds only a still-NULL unchanged entity and appends a binding audit. Orders, attempts, actions and action attempts are reviewed separately. Action provenance additionally requires its reviewed immutable snapshot and reference kind; binding an order does not prove an earlier action's dispatch account. A conflicting ledger entry rolls back without changing financial facts.

After mixed profiles or namespace cutover, use only profile-aware rollback builds. Keep the guard closed and preserve bindings, inboxes, claims, history and namespace indexes. Never recreate unsafe global constraints or deploy an old single-client binary over bound financial rows.

## Validation scope

`npm test` exercises synthetic localhost clients and Academy regressions. `npm run test:mysql` requires a disposable localhost `MYSQL_TEST_URL` whose schema starts with `galatic_test_`; it resets only that schema. The CI job supplies an isolated MySQL 8.4 service. It exercises expansion, final namespace cutover, collisions, claims, reviewed CAS, uncertain operations and action version races.

Queue-leasing transactions use `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` for their next transaction only; financial claims and business/CAS transactions retain their existing isolation. This reduces gap-lock deadlocks without promising their elimination or retrying financial POSTs. Pool-saturation acceptance uses twelve simultaneous reservations against the ten-connection pool; phase checks run on the transaction's own connection. Ledger fingerprints cover the complete row using canonical JSON and UTC date representations; reviewed snapshots must use the same UTC source convention as the store.

`scripts/run-local-profile-mysql.mjs` is a Windows developer harness requiring explicit `--mysql-base` and `--runtime-root`. It checks local port 33081, initializes a fresh UUID datadir, generates a memory-only root password, runs the guarded suite, stops only its own server and removes only its validated datadir. Server logs remain under the unique run directory. It reads no existing database configuration or retained passwords.

Synthetic acceptance does not establish a real merchant, actual provider payment/refund, webhook delivery, email delivery, supplier approval or commercial opening. The earlier real Sandbox refund remains a separate unresolved operation and is not retried by this migration.
