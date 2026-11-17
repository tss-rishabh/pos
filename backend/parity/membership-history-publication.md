# Source-authenticated membership history publication candidate

The source capture, independent BigQuery candidate reader and complete-manifest
sealer are executable code. They close the reader slice's missing producer code.
They do not deploy the source process, ETL/generation projections, native writer
identity/key, warehouse tables or publication upload. Default source capture and
reader contracts remain unselected. No source/warehouse data or schemas were
changed during verification; native writes were confined to disposable fixtures.

## Source and time

The producer follows the same pinned source used by the reader:
API-v2 commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`, Cart SHA-256
`1f9eff0f1a4ea66f3cac8903d3c1cb9a5b39e2a3babd6dd6c8dcf192de7defd3`.
It preserves delivered `order_status=3`, all-time latest, strict 45-day cutoff,
all HP rows, no payment-status predicate and the original inverted ordinary-line
exclusive flag. Equal latest/recent timestamps, mixed ordinary flags, invalid
dates/flags and incomplete bounds refuse publication. Neither a source-only
`complete:true` nor the absence of warehouse records becomes qualified history.

`captureForDispatch` records the source execution wall second **inside its own
actual consistent snapshot**, after acquiring the connection and beginning the
read-only transaction. It derives asOf/cutoff there. A connection delay across a
second cannot retain an old pre-connection clock. The strict `capture(request,id)`
variant rejects that mismatch. Only the returned `capture.scope` is used for
warehouse preparation and the later membership-only source clock freeze. It
never substitutes the imported order's business date, modifies its header,
infers payment or changes membership accounting.

The source query formats seconds. The publication's `source_snapshot_at` retains
that literal criteria-clock precision. The signed native capture separately
records the exact millisecond `capturedAt` and `finishedAt`, physical writer
server UUID/schema and an opaque snapshot UUID. This is one authenticated source
snapshot, not a claimed GTID, global current-head revision, continuous writer
fence or proof that no later source write exists. An old snapshot is not relabeled
as current. A future participating-writer/current-head policy would need its own
concrete producer; this candidate deliberately preserves the retained snapshot
semantics used by the membership evaluator.

## Callable root hooks

All new files are under `membership-profile/`; no app/env/financial transport,
profile manager or migration registry was changed.

```ts
const source = csvMembershipNativeSnapshot(
  sourceDatabases,
  {
    contract: 'pos-csv-membership-native-snapshot-v1', // absent => disabled
    sourceSchema: verifiedSourceSchema,
    sourceServerUuid: verifiedWriterServerUuid,
    sourceTimeZone: verifiedSourceProcessTimeZone,
    timeoutMs: 8000,
    maxOrders: 1000,
    maxLines: 10000,
  },
  { sourceKey, memberProductIds },
);

// Outside any financial SQL transaction, before an order nonce/POST:
const capture = await source.captureForDispatch(
  { operationId, requestHash, planHash, customerId },
  generationId,
);

// An approved ingestion publisher stages immutable generation facts plus the
// exact candidate-control row. This code/reader does no upload or cloud writes.
// sourceSnapshotId= capture.sourceSnapshotId
// sourceCaptureHash= capture.signature

const warehouse = csvMembershipWarehouseCapture(bigQueryOptions, qualifiedCandidateView, {
  sourceKey,
  memberProductIds,
});
const { publication } = await sealCsvMembershipHistoryPublication(
  capture,
  warehouse,
  { sourceKey, publicationKey, historyKey, memberProductIds },
  { sourceTimeZone: verifiedSourceProcessTimeZone },
);

// Publish ONLY this verified manifest LAST under the approved publisher
// identity. Then use capture.scope with the read-only BigQuery history port
// and prefetch bridge. Retain the exact original capture/document/capability.
```

The three server keys are distinct printable-ASCII 32–4096-byte purpose secrets:
native source capture, publication, and history document/prefetch. No key is
uploaded to BQ, put in a URL, read back to a browser or logged. The private
capture includes operation/request/plan/customer/time/generation binding; the
candidate control must match its native signature and snapshot UUID exactly.
Root's authenticated owned-import preparation must remain authoritative for the
current manager, customer, store/counter, session and original financial scope.
These internal ports are not arbitrary browser/customer lookup endpoints.

The reader document remains capped at 1 MB; the complete prepared handoff adds a
small strict capability. Root must use explicit bounded private transport and
sealed-journal capacity for that document alongside the existing plan. It must
never log the payload, recapture after an unknown financial outcome, perform
BQ/HTTP while holding financial locks, or dispatch an order before preparation
succeeds. Missing/stale/over-budget preparation remains pre-dispatch no effect.

Root integration inputs (no shared env edits here): existing reader options from
`membership-history-bigquery.md`, plus one qualified
`BQ_CSV_MEMBERSHIP_CANDIDATES_VIEW`, explicit native snapshot contract, verified
source writer schema/server UUID, and the distinct `sourceKey`. The factory
accepts these through typed arguments; root owns final environment names and
private service composition. No new automatic MySQL migration or worker is
required for these read-only ports. Publication loading/deployment uses a
separate approved writer identity; the supplied BQ reader SA is never promoted.

## Native guarantees

`publication-native.ts` has narrow read-only ORM mappings for verified physical
`orders` and `has_products` columns. The generated Django HP mapping omits
`is_exclusive_order`; the shared schema was preserved. It uses the configured
writer pool only, matches actual schema/server UUID, rejects read-only/replica
server roles and requires both InnoDB base tables. The account can itself remain
SELECT-only; this does not grant a mutation or use a writable transaction.

`publication-transaction.ts` owns one dedicated connection and executes fixed
transaction control followed by ORM selects. Installed Drizzle 0.45.4 joins
`WITH CONSISTENT SNAPSHOT` and `READ ONLY` without the MySQL-required comma; its
failed-BEGIN path also fails to release the acquired connection. This adapter
uses the actual valid `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`,
never patches the dependency, and guarantees rollback/release or destroy on
setup/rollback failure. A real UPDATE attempt in the test transaction is rejected
by MySQL read-only mode. A concurrent HP commit after snapshot start remains
invisible to that capture and is visible to the next capture.

Queries retain exact signed-positive BIGINT strings, apply a shrinking
`MAX_EXECUTION_TIME` hint and one total deadline. The full delivered existence
count and latest-tie check are independent integrity queries; latest/recent
headers and one bounded HP batch reproduce the source SELECT result sets.
Bounds refuse oversized histories without signing a partial result. Session
setup/driver/SQL errors map to static resource codes. No raw exception, query
values, contacts, credentials or body is logged.

Suggested source-only performance review, with identical normal results:
`orders(user_id,order_status,created_at,id)` and `has_products(order_id,id)`.
Existing user/order lookup indexes can serve the bounded capture; any composite
index change requires measured production plans and separate reviewed DDL. No
live index or schema change is included.

## Warehouse guarantees and schema

The candidate reader uses the same bounded counts/header/HP query and pure
verifier as the production reader. It independently computes warehouse count,
uniqueness and selected-row digest. The sealer compares them against the native
capture; it never substitutes native rows as warehouse history. Wrong generation,
customer, asOf/cutoff, snapshot, capture signature, CDC time, counts, line flags
or missing/duplicate candidate control refuses the manifest. A signed native zero
still requires one real staged candidate-control row and existing projection
tables. Native source capture is a control-plane authenticity proof, not a
historical MySQL response fallback.

The source signature is
`operationHash('legacy-order-imports.membership-source-capture.v1',body,sourceKey)`;
`verifyCsvMembershipSourceCapture` validates its complete strict body and bounded
selection. It does not trust a caller's count, signature boolean or mutable
source financial paid flag. Source/warehouse manifests reuse the reader's exact
canonical selection hash/publication HMAC contract. `qualifyCsvMembershipWarehouseSnapshot`
is now the pure common verifier, so the sealer does not create fake view names or
simulate a warehouse query to reuse validation. The SDK's optional compiled
candidate definition still checks its exact known SQL/params/types, SELECT-only
shape, reference scope, deadline, bytes and no auto-pagination.

All projections now require `scope_shard = MOD(customer_id,1024)` as INT64,
derived using exact BIGINT arithmetic. Every candidate/publication/header/line
query binds the shard explicitly. Review-only schema/partition definitions are
in `compatibility/upstream/legacy-order-imports/membership-history-publication.review.sql`.
There are four tables: order facts, HP facts, candidate controls and complete
publications. Full current source-customer headers are needed even outside 45
days; the selected source capture is not an instruction to load only recent
headers. Never alias unrelated raw stock/order tables or derive all expected
source hashes from warehouse rows. Candidate rows are not final manifests.

## Evidence and remaining acceptance

Focused commands from `backend/`:

```sh
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tools/legacy-order-imports/membership-publication.tsconfig.json
MEMBERSHIP_PUBLICATION_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_integration npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/legacy-order-imports/membership-publication.test.ts tests/legacy-order-imports/membership-publication.mysql.test.ts tests/legacy-order-imports/membership-publication-transaction.test.ts tests/legacy-order-imports/membership-bigquery.test.ts tests/legacy-order-imports/membership-bigquery-sdk.test.ts tests/legacy-order-imports/membership-bigquery-source.test.ts tests/legacy-order-imports/membership-bridge.test.ts --maxWorkers 2
```

Tests cover actual native read-only/RR behavior, concurrent changes, exact IDs,
source rules, empty capture/control, clock crossing, immutable proof tampering,
wrong scope, stale/future/incomplete generations, bytes/deadlines and cleanup
after failed setup/rollback. The source oracle reads the declared immutable 2960
Git blobs: unrelated clean sibling commits no longer change its pinned enum
input. No whole-source pin was weakened or source sibling edited.
The final focused run passed 105 cases across seven files: 40 producer cases
(including nine executed native MySQL cases) and all 65 reader/bridge regressions.
Scoped strict TypeScript and lint passed. No test timeout was increased.

Optional authorized compile-only SDK check:

```sh
GOOGLE_APPLICATION_CREDENTIALS=/Users/rishabhbhatia/Downloads/reports-bigquery-reader.json npx -y node@24.22.3 --import tsx tools/legacy-order-imports/membership-publication-dry-run.ts --live
```

It compiles complete/empty generated-literal candidate shapes only, with
`dryRun:true` and no query execution/source rows/DDL/uploads/credential-byte
inspection. Both candidate shapes compiled successfully on the authorized project/location,
with estimated bytes zero; the reader complete/empty shapes were also qualified.
The source publisher/warehouse reader/sealer code is implemented. Real source-writer identity/timezone, ingestion lineage and immutable staging,
actual publication loading/availability, transport/journal composition and real
source-profile acceptance remain unaccepted. Current raw CDC metadata alone
provides none of those proofs. Nothing here marks a production release or full
workflow parity certification.
