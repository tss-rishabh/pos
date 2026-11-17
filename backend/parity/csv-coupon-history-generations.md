# Generic CSV coupon history generations

Implementation handoff, **pending final validation**. The user changed the work
order on 18 November 2026: finish feature/integration code before further parity
and test runs. Existing tests and acceptance criteria are retained. No warehouse
DDL, warehouse writes, deployment, or source financial effects were executed for
this handoff. Production selectors remain unselected.

The earlier operation-scoped `history-bigquery*`/`history-warehouse*` capability is
qualification tooling. Its native scope includes operationId, requestHash,
planHash and asOf, so its seal cannot honestly be prepublished for a new operation.
It is not the production generation provider and must not become a native runtime
history fallback.

## Implemented protocol

A generic source snapshot binds customer, coupon, actual source processing day,
source time zone, configuration hash, real writer origin, current global/coupon/
customer heads and the source-writer definition hash. It has no operation nonce,
request hash, plan hash or fabricated operation capture. It retains the real
snapshot wall clock, a genuine current-control descriptor and genuine source
signature.

The background publisher captures the five literal native facts and the complete
bounded primitive source sets in one READ ONLY repeatable-read writer-origin
snapshot. BigQuery materialization independently selects source order primitives,
and imports only bounded publisher-captured log primitives and native comparison
controls. A second bounded SELECT independently computes the five facts and row
commitments. The publication sealer accepts only an exact comparison with the
signed native capture. It never substitutes the native counts for the query.

The runtime reads only an already published generation from BigQuery. It verifies
both seals, the actual candidate facts/commitments, native comparison controls,
source day/configuration/origin and the operation's qualified current three-head
witness. It then signs a new **operation-bound history document**, retaining the
original generic source-capture hash/publication seal. It never creates a native
capture for that operation. Two new operations can reuse the generation only while
those exact invariants and genuine freshness remain unchanged. The existing
source late-head fence remains mandatory before source order dispatch.

The history fetchedAt is the earlier of the genuine source capture and source
control observation. Reading/rebinding does not extend it. A generation is bounded
by 60 seconds, the source descriptor expiry, the source day end, and the unchanged
consumer/bridge deadline. The CSV's historical order date is not the source day.

## Exact source semantics retained

- Global coupon usage includes all customers and every source-eligible status.
- Today's birthday count uses the actual source calendar day and its original
  status predicates. First-user eligibility counts all source-eligible orders.
- Monthly coupon-log usage joins on user and coupon, **not order ID**. Counts
  preserve the literal multiplication of matching logs and orders.
- Lot usage preserves the same multiplication, native lot collation/PAD SPACE
  equality, exact decoded voucher-code equality and original lot counters.
- Future rows remain present wherever the original predicate has no upper bound.
  No convenient sourceAsOf cutoff, status normalization or LOWER comparison is
  introduced. Source orphan/null rows are retained for the literal joins; missing
  required control/projection evidence fails closed.

The generic order set is exactly `(user_id=customer OR coupon_used=coupon)`.
Materialization partitions that set into coupon rows plus customer rows with a
NULL/different coupon. It does not deduplicate rows to conceal corrupt input.
The log set contains every coupon-log row for that customer. No raw coupon code,
lot, contact, customer ID or log ID is logged or printed by the production
components. Primitives and control flags are private warehouse/journal data.

For source-set conservation, each canonical primitive row includes its exact
signed64 ID, user/coupon/status and source calendar date. Ordered numeric IDs feed
SHA-256 row hashes, 1,000-row chunk hashes and an ordered final hash. Counts and
unique counts are independently checked. Calendar dates are sufficient for these
literal date/month predicates; source heads still fence any intervening change.
This is a cryptographic comparison of the captured bounded fields, subject to
SHA-256 assumptions and the authenticated producer/writer boundary. It is not a
proof that arbitrary raw CDC is complete or a universal full-row digest.

## Current control descriptor dependency

Root commit `02cb5b0` implements the source producer agreed with this module:

- GET `/internal/pos/coupon-history/controls/current`, no body/query.
- Header `X-POS-Coupon-History-Controls-Key` with an independent resource key.
- Source selector `POS_COUPON_GENERATION_CONTROLS_CONTRACT=`
  `pos-csv-coupon-generation-controls-v1`; key
  `POS_COUPON_GENERATION_CONTROLS_KEY`.
- Strict envelope `{data,proofHash}`. The source proof purpose is
  `coupon-generation-config` in the existing benefit HMAC domain.
- Actual source two-cache-key snapshot + pinned settings + current native coupon
  input produce configurationHash. The literal current-control traversal stops
  before its first historical query. The descriptor contains no operation,
  customer or history counts.
- Real source UUID/schema, processing day/time/zone, observedAt/expiresAt and
  authentic global/coupon heads are included. No MySQL-only substitute for the
  cache/settings hash is accepted.

`generationControlHttp` is a bounded HTTPS GET client: exact path, no credentials
in URL/query, no redirects/retries, typed envelope, 16 KB response and a shared
abort/deadline. The descriptor is checked before native history capture; the
native snapshot must match its coupon input/origin/two heads. Source-producer
implementation and this Node consumer remain separate ownership boundaries.

## Writer-origin and warehouse boundaries

`generationSourceOrigin(databaseGetter,{serverUuid,sourceSchema})` requires an
explicit writer-origin **SELECT-only** connection. There is no `primary` fallback.
The actual `@@server_uuid` and DATABASE() must match this identity and the source
control descriptor. A physical reader replica with another UUID is refused, even
if its row values happen to match. Failover requires a newly authenticated writer
origin and new captures; identity is never overwritten to make a replica fit.
Existing job acknowledgments can still be read under retained keys/config.

Native capture is publisher-only. It verifies the actual trigger definitions,
keeps one readonly snapshot, bounds rows/pages/bytes and SQL duration, and exports
no raw code/lot. Default bounds: 100,000 order rows, 10,000 log rows, 8 MB exported
logs, 30 seconds overall; hard limits are 1 million orders, 50,000 logs and 40
seconds. Each historical SELECT has a 5-second native execution hint.

A fresh bounded read-only metadata check on 17 November 2026 found none of the
exact BigQuery names `tss_order_coupon_log`, `order_coupon_log`, or
`tss_order_coupon_logs`. It read INFORMATION_SCHEMA only, not application rows.
Therefore this implementation explicitly exports bounded log **primitives** in
the publisher; the application never calls native history on a warehouse miss.

All warehouse resources are fixed to project `tssgcp2025`, dataset
`tss_mysql_raw_layer`, location `asia-south1`. Query identifiers are validated;
values use explicit parameter types. The runtime/candidate SDK is lazy, SELECT
only, dry-run-before-execute, with bounded bytes, one response document, no automatic
pagination, bounded deadline/abort and late-job cancellation. Missing, duplicate,
mixed, stale, malformed, tampered or over-budget evidence is refused. Empty history
requires a genuine matching complete source capture, not absence of a row.

The production warehouse writer is **separate**. `generationGoogleWarehouseWriter`
requires explicitly supplied service-account material, a distinct reader identity
and the exact writer contract. There is no ADC/key-file/default credential path.
The lazy Google SDK disables retries. Constructors do no network, SQL, DDL, timer
or credential lookup. The authorized readonly SA must never be supplied to this
writer.

## Durable publication and recovery

`generationJournal` stores the exact original snapshot, plans, typed values and
job IDs encrypted with AES-256-GCM under an independent purpose-derived journal
key. Its immutable identity/version/phase are authenticated. Only opaque generation
IDs, phase/version/update metadata and ciphertext are indexed. No native SQL lock
is held across a warehouse call.

Materialization and publication each have one durable claim and deterministic job
ID. A worker that loses its reply reads that original job forever; it never starts
a second job or chooses a new nonce. A later process accepting success verifies
project/location/ID, exact original script, parameter names/types/values and
DONE/no errorResult. An HTTP acknowledgment or mutable candidate flag is
insufficient. Retained reads and factual original-job evidence continue when new
work is disabled; incomplete stages cannot advance to new writes then.

Materialization atomically appends orders/logs/controls and a complete candidate.
It asserts absence of every original generation set first. Publication atomically
asserts the exact candidate and absence of its publication, then appends the sealed
publication. Its plans cannot UPDATE/DELETE/MERGE legacy/source data. BigQuery
script dry runs are not execution proof; the separate SELECT preflight bounds the
source scan and actual jobs carry maximumBytesBilled/deadlines. See Google's
[multi-statement query](https://docs.cloud.google.com/bigquery/docs/multi-statement-queries),
[transaction](https://docs.cloud.google.com/bigquery/docs/transactions), and
[job result](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job)
contracts.

`couponGenerationWorker` has bounded, indexed keyset sweeps of pending journal
phases. Unknown jobs do not starve later work. It starts no timer until explicit
start(); prepareCustomers accepts bounded trusted upcoming customer IDs for an
independent background schedule. This is never invoked as the runtime reader's
fallback. The source generation can be reused by new operation nonces once ready.

## Integration hooks and configuration

Root owns app/preparation/worker registration, migration numbering and shared env.
No common prep/app file is changed in this commit.

1. Inject `couponHistoryRuntime(env,{sourceKey,publicationKey,historyKey})` as
   `sourceOrderPreparation(...,{couponHistoryReader})`. No selector returns
   undefined, never a different history provider.
2. Compose `couponGenerationPublishingRuntime(options,{sourceKey,publicationKey,
historyKey,journalKey},dependencies)` in a separate background process.
   Dependencies are the writer DB for the journal, explicit readonly source origin,
   controlHttp options, separately credentialed warehouse writer, newWorkEnabled
   callback, and worker options. Call worker.prepareCustomers with authorized
   upcoming customers; then start/drain the worker. Stop it before closing pools.
3. Keep sourceKey, publicationKey, historyKey, journalKey and the controls resource
   key separate. Retain old keys and writer read capability for recovery. Only
   newWorkEnabled allows first dispatch; worker selection alone cannot enable it.
4. Register the rewrite-only journal DDL from `generationJournalDdl` or
   `compatibility/warehouse/coupon-history-generations/journal.review.sql`.
   `generation-render.ts --journal-sql` renders SQL and does not execute it.
5. Review/deploy the five warehouse tables in `schema.review.sql`. Projection
   rows are source-day partitioned; all query/write existence predicates include
   source_day. Review access, retention, location and append-only publisher IAM.
6. Supply the two independently sourced bounded order layouts. Review SQL is in
   `source-inputs.review.sql`; `source-inputs-refresh.review.sql` provides an
   actual separate snapshot/refresh workflow from existing raw orders, without
   native counts. Its full-scan deployment budget/identity/schedule are separately
   authorized; this implementation has not invoked it. A continuous approved
   equivalent may replace it. Mixed refreshes fail qualification rather than
   fabricating a common CDC watermark. No implicit raw-table fallback is selected.

Runtime options read by `readGenerationOptions`:

| Environment                                   | Value                                           |
| --------------------------------------------- | ----------------------------------------------- |
| CSV_COUPON_GENERATION_CONTRACT                | pos-csv-coupon-generation-runtime-v1            |
| BQ_CSV_COUPON_GENERATIONS_VIEW                | qualified publications table/view               |
| BQ_CSV_COUPON_GENERATION_CANDIDATES_VIEW      | complete candidate table/view                   |
| BQ_CSV_COUPON_GENERATION_ORDERS_VIEW          | immutable scoped orders                         |
| BQ_CSV_COUPON_GENERATION_LOGS_VIEW            | immutable scoped log primitives                 |
| BQ_CSV_COUPON_GENERATION_CONTROLS_VIEW        | authenticated native comparison flags           |
| BQ_CSV_COUPON_SOURCE_ORDERS_BY_CUSTOMER_VIEW  | independent source customer layout              |
| BQ_CSV_COUPON_SOURCE_ORDERS_BY_COUPON_VIEW    | independent source coupon layout                |
| CSV_COUPON_SOURCE_TIMEZONE                    | actual source timezone                          |
| CSV_COUPON_COMPARISON_FINGERPRINT             | reviewed native collation/PAD SPACE fingerprint |
| CSV_COUPON_MAX_BYTES_BILLED                   | default 50,000,000; hard 1,000,000,000          |
| CSV_COUPON_QUERY_TIMEOUT_MS                   | default 8,000; hard 10,000                      |
| CSV_COUPON_MAX_CONTROLS / CSV_COUPON_MAX_LOTS | default/hard 10,000 / 1,000                     |
| CSV_COUPON_GENERATION_MAX_LAG_MS              | default/hard 60,000                             |

The controls helper reads CSV_COUPON_GENERATION_CONTROLS_CONTRACT, URL, KEY and
TIMEOUT_MS (default 5,000; hard 10,000). Worker helper reads
CSV_COUPON_GENERATION_WORKER_ENABLED (false), INTERVAL_MS (5,000), BATCH_SIZE (10)
and DEADLINE_MS (20,000). Root supplies the independent journal key and explicit
warehouse writer credentials through the factory, not through a reader ADC path.
Writer selection is `pos-csv-coupon-generation-writer-v1`; explicit source origin
selection is `pos-coupon-writer-origin-readonly-v1`.

## Validation phase and remaining integration

The new implementation is committed for integration **before final validation**.
The retained focused generation/native/writer/publisher tests and scoped strict
config are in `tests/legacy-import-coupon-history/generation*` and
`tools/legacy-import-coupon-history/generation.tsconfig.json`. Existing tests were
not removed or weakened. Earlier focused checks preceded the final mandatory
control/worker/layout integration and are not certification of this final state.
A bounded synthetic BigQuery run reached a chunked published-read case that still
requires diagnosis/validation; it was stopped when the user reordered work.
No writer credential, warehouse write or DDL execution was attempted.

Remaining integration CODE belongs to Root: inject the runtime port, register the
background publisher/worker and trusted upcoming-customer schedule, connect the
signed source resource, register the journal migration, and map deployment config.
No missing descriptor is replaced by a caller configuration assertion.

External acceptance afterward includes reviewed source-trigger rollout, qualified
writer-origin readonly credentials/identity and failover handling, the independent
source-control key/resource, separate warehouse writer IAM, actual source-layout
publication/refresh, warehouse schema/access/retention and final source/native/BQ/
security/abort/recovery/performance verification. These are explicit prerequisites,
not claims that current selectors can safely be enabled.

Exact head equality can legitimately starve a hot coupon: global coupon writes
invalidate every customer's publication. At generation latency L and illustrative
independent head-change rate lambda, the no-change window probability is
exp(-lambda*L). This is a capacity warning, not a measured model of production.
Measure capture/CDC/materialization/qualification latency and rejection/ready rate
before performance acceptance. Never extend stale generations, suppress head
changes or use native runtime history to conceal insufficient throughput.

## Trusted preview demand queue

`history-generation-demands.ts` exports the pure
`couponGenerationDemands(db,{journalKey,sourceKey},clock?)` constructor and
`GenerationDemandPort`. Root selects it only with
`CSV_COUPON_GENERATION_DEMAND_CONTRACT=pos-csv-coupon-generation-demands-v1` and
`CSV_COUPON_GENERATION_JOURNAL_KEY`, retaining full key separation. The port is:
`enqueue(scope:CouponHistoryScope,{witness:CouponHistoryWitness,signal?})` returning
an opaque ID, pending/preparing/prepared/failed status and nullable generationId.

Only a fully validated signed source preview may call it. Root owns that hook,
only after the selected reader's GENERATION_INCOMPLETE result. Abort propagates;
a queue failure must not replace the original history refusal. Enqueue performs
one native encrypted queue transaction and no native history, HTTP, BQ or source
financial dispatch. Exact original scope+witness is deduped by a separate-purpose
HMAC; cleartext customer/plan/nonce data is not indexed or logged.

`couponGenerationDemandWorker` leases bounded readonly preparation work. Its
publisher capture may retry before any warehouse journal exists. A successful
capture inserts the generation journal intent and binds the original demand
**in one SQL transaction**, through journal.create's optional binding callback.
A crash commits both or neither. This closes an untracked-publication interval.
After that bind, only the original generation's publisher/GET recovery runs; no
source-order action is retried. Additive queue review DDL is
`compatibility/warehouse/coupon-history-generations/demands.review.sql`.
Runnable background startup/configuration is a separate follow-up handoff.
