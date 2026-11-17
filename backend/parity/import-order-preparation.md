# Native pre-source preparation lifecycle

This implements the optional asynchronous preparation boundary before the first CSV-import order dispatch. It does not select a production source, screening, membership, or warehouse contract. Source eligibility and the read-only preview/history producer remain separate from this orchestration layer.

## Server integration

Apply the rewrite-owned `src/modules/legacy-order-imports/preparation-migration.sql` through the deterministic migration registry and include it in the backend image. Missing or malformed control storage fails closed. No source table DDL is needed.

Pass a qualified producer as the optional sixth argument to `legacyOrderImportFinancialAdapter(config, db, financialOptions, transport, profiles, orderPreparation)`. Its exact interface is exported by `financial-adapter-preparation-contracts.ts`:

```ts
prepare(
  { state, plan, attemptId, expiresAt },
  { signal },
): Promise<{ membershipHistory?: CsvMembershipPrefetch }>
```

The callback receives independent copies of the retained state/plan and runs after every native SQL transaction has ended. It receives no SQL transaction or owner token. Only the actual source preview may determine whether historical membership input is needed; this adapter does not infer eligibility from CSV prices or require BigQuery for every import. The producer must honor the abort signal and qualify its own HTTPS, source capability, publication and budget boundaries. No preparation callback is invoked by GET/recovery.

The existing repository/service now consumes the adapter's private `preparation` hooks. Selected work uses the existing owned READ COMMITTED runner, without automatic lock/deadlock retries. The queue claim locks actor/epoch → Store → queue job/row → financial operation → profile/customer. Native operation insertion, screening admission, STARTING/RUNNING queue claim, and the RESERVED preparation owner commit in that same transaction. No second pool transaction is acquired inside it. The private execution lease returned to `start` must match current native owner HMAC, attempt, queue token, row scope, STARTING status and both expiries. A direct start cannot omit the lease for a queued operation.

Keep public `canStart` false when the source/producer is unqualified. Retaining the financial key still permits proof-only reads and cancellation of paused preparation when the optional producer is disabled. Construction performs no database queries or external effects.

## Positive control evidence

Selection adds optional `preparationContract: 'pos-import-order-preparation-v1'` to the native financial state and request HMAC. It has no default: previous ordinary and corrected requests/proofs retain their original bytes when absent.

`pos_rewrite_import_financial_preparations` stores bounded authenticated attempts with UUID, immutable scope/plan/request/authority hashes, sequence/previous ID, phase, private queue binding, owner HMAC, expiry and closure/artifact hashes. JSON reads are bounded to 16KB, history to 64 attempts, and prepared plaintext to 1MiB. The retained artifact is authenticated and encrypted with operation/request/attempt AAD. Owner tokens and artifacts never enter public DTOs, URLs or logs.

The state sequence is:

1. An atomic native claim creates RESERVED; `start` consumes the exact owner once into RUNNING.
2. Successful outside-SQL preparation returns to a fresh native transaction. Current authority/profile/queue/owner/expiry are rechecked. The encrypted artifact, DISPATCHED attempt and the one original order checkpoint commit together, before transport.
3. A live lease read reports unknown and does no new work. A failed owner or an expired retained attempt can close only under the operation dispatch fence and current locking absence checks for **all** stage, binding, source-receipt, effect, financial-proof and close-impact rows, without filtering their status/kind.
4. That closure is a purpose-HMACed `pos-import-native-no-dispatch-v1` receipt with exact scope, plan/request/authority hashes, namespace, attempt/sequence, nonce, time and FAILED/EXPIRED/CANCELLED code. It is native preparation evidence, never a fabricated upstream no-effects rejection.

Expiry or an absent operation alone is not a release proof. A DISPATCHED checkpoint can never be closed as no-effects, even if the process lost its commit acknowledgement before transport. It remains uncertain and is never resent. A late callback cannot create a checkpoint after another transaction closes its attempt.

## Pause, explicit resume and cancellation

The financial result uses `ORDER_IMPORT_PREPARATION_RETRY_REQUIRED` after a proved unused attempt. A screening cleanup failure uses `ORDER_IMPORT_PREPARATION_RELEASE_REQUIRED` and retains quota. The queue preserves its original row as PENDING, sets the job BLOCKED, and does not increment failure/import counters. Original operation IDs and input remain intact.

The existing authorized POST `/api/v1/admin/order-imports/:jobId/resumptions` with `{operationId}` can explicitly authorize a new attempt. GET `.../resumptions/:operationId` only reads its exact receipt. A replay reads the same acceptance and cannot authorize another attempt or renew a later pause. A fresh authorization appends AUTHORIZED, holds no quota and performs no preview/BigQuery/source work. The next actual queue claim rechecks unchanged original authority, current catalog and quota, mints a fresh private owner, and reserves quota again. A source-local admission failure rolls back its savepoint and seals the new native unused-attempt proof; an already released quota row advances to that exact new proof so a later repaired resume is possible.

The client reuses its existing resumption journal/command schema. The actual import screen offers explicit resume for these two pause codes in addition to ACCESS_CHANGED and never mints a replacement UUID after a lost reply. An operator may instead cancel the paused or authorized-but-unclaimed operation, including with the optional producer disabled. The original append-only closure/attempt evidence stays retained.

**Remaining code edge:** changed original contact/epoch/customer authority cannot be rearmed by this same-operation resume. It remains safely paused. An explicit successor/reference-transfer workflow for that case is not implemented here. No authorization is inferred from a restored contact value, changed actor, or a newer approval. Reaching the 64-attempt bound also requires explicit reconciliation rather than silently discarding control history.

## Screening and immutable recovery

Only RESERVED screening quota with no native order/source receipt can be released by a verified native closure. Source-rejected and bound/COUNTED reservations retain their existing separate proof contracts. Cleanup requires the retained screening proof key; missing flags alone need not prevent reading/releasing a previously authenticated unused reservation. Missing/wrong keys or malformed ledgers retain quota and require review. A later explicit resume reacquires current admission; AUTHORIZED alone consumes none.

When a preparation survives flag disablement, the adapter detects its authenticated native contract and reopens that scoped read in the owned current-read runner before any mutation. That first inspection transaction performs no mutation. Existing completed financial seals are still recovered before mutable membership/contact/entitlement/source gates; the new control path does not convert GET into creation. The existing worker's recovery mode continues to claim only STARTING/RECONCILING work, never PENDING jobs. A blocked PENDING pause waits for explicit resume/cancel; cleanup is also retried as part of those authorized operations.

## Evidence and commands

All tests use generated fixtures and random disposable local MySQL schemas. No source customer/order rows, provider calls, production writes or source schema changes are involved.

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  npx vitest run tests/legacy-import-preparation --maxWorkers=1
npx tsc -p tests/legacy-import-preparation/tsconfig.json --noEmit
```

The 28 focused native checks pass. They cover native owner contention and HMAC/size tampering, authenticated no-dispatch absence, live/expired/late callbacks, SQL-lock-free async work, atomic queue/profile rollback, screening release/re-admission, disabled-option cleanup/cancellation, actor revocation, explicit job-resource resume, exact-command recovery, and actual post-native-COMMIT acknowledgement loss at claim/closure/dispatch/resume/completion. Financial checks prove no extra source order, charge or checkpoint is created by those recoveries. The final combined run with existing repository/resumption tests passed all 44 checks; the dedicated strict TypeScript program and lint passed.

The existing 147 checks across financial adapter, membership core, pinned original screening/source oracle, repository, resumptions, job API/runtime and membership bridge passed after the core change. Those are scoped regression results, not a whole-project or production acceptance certificate. Root integration must compose the independently qualified preview/history producer and run the consolidated verifier/source/Go suites against the final merged tree.

## Installed runtime checkpoint

`configuredLegacyOrderImports` now installs `sourceOrderPreparation` as the actual sixth adapter argument when `UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT=pos-import-order-preparation-v1` is explicitly selected. The server and standalone worker already share this runtime factory. Absent selection preserves the previous ordinary path and does not parse unused warehouse options. Invalid selected preparation configuration keeps `canStart` false and installs a new-work denial guard while retaining the authenticated completion reader. No constructor opens SQL, a broker or HTTP.

The deterministic migration registry includes the native preparation SQL; the existing backend Docker `src/modules/legacy-order-imports/*.sql` copy includes it. The fixture strict programs are `tests/legacy-import-preparation/tsconfig.json` and the separate producer `tools/legacy-import-preparation/tsconfig.json`.

Three additional native runtime/API/worker tests pass: the installed producer completes one native source order/confirmation/settlement/publication without unused history, a failed preview produces only the native no-dispatch pause, and completed API/worker recovery survives invalid selected producer settings without a new dispatch. The tests use real durable native tables and an injected signed synthetic source transport, not a live provider. Four additional pure runtime cases prove constructor silence and safe selected/absent/invalid configuration. The complete preparation/core/producer/runtime checkpoint passes all 80 cases with the immutable API-v2 archive. Both fixture strict programs pass. All 39 import browser/unit checks pass, including both new preparation pause codes recovering a lost resume response by the same saved UUID and GET only. No production flag is selected by this change.
