# Terminal legacy order import history

This implements the historical read boundary for the rewrite's durable offline/
Shopify CSV import queue. Original CSV grouping, order punching and financial
receipts remain the root `legacy-order-imports` slice. These tests qualify the
new queue metadata contract; they do not recertify original CSV parsing,
financial side effects, deployed datasets or a live publisher.

The only runtime file owned here is `src/modules/legacy-order-imports/history.ts`.
It has no database client, filesystem source fallback, encrypted-payload decoder,
financial gateway or mutation. `legacyOrderImportHistory(config,options?,warehouse?,clock?)`
exports `detail(anchor)` and `results(anchor,after=0,limit=50)`. Results retain the
current repository's public job DTO and ascending row-array shape; no HTTP/API
shape change is required. Numeric sequence keysets stay bounded to 0–50000 and
page limits 1–100. Whole-job verification occurs in the same BigQuery SELECT as
the selected page. The default shared warehouse adapter retains its configured
billing/timeout limits; this module never raises them.

## Writer authority and routing

Root constructs `LegacyOrderImportHistoryAnchor` after its writer-current owner,
operator, store and counter checks. The anchor is `{job,scopes}`: job contains
sequence/id/actor/requestHash/kind/state/counts/errorCode and the three timestamps;
scopes are the exact imported store/counter pairs. A full native Drizzle job is
accepted, with private extra fields stripped. No client-supplied anchor is an
authorization credential. Finish the writer transaction before BigQuery I/O,
then recheck current authority/unchanged anchor and the revocable HTTP session
before replying. No SQL locks need span a remote query.

Only terminal COMPLETED/PARTIAL/FAILED/CANCELLED jobs whose completion is strictly
older than 24 hours are accepted. The exact 24 hour boundary remains current. The
factory independently rejects active or inconsistent anchors and refuses
historical MySQL fallback. Root keeps pending/uncertain/current operations and
native receipt authorization authoritative. Historical result metadata must
never authorize an order, stock or money operation.

All three views plus the contract must be configured:

- `ORDER_IMPORT_HISTORY_CONTRACT=pos-order-import-history-v1`
- `BQ_ORDER_IMPORT_JOBS_VIEW`
- `BQ_ORDER_IMPORT_RESULTS_VIEW`
- `BQ_ORDER_IMPORT_PUBLICATIONS_VIEW`

`readLegacyOrderImportHistoryOptions` validates fully qualified identifiers.
Empty options stay disabled; missing inputs return `ORDER_IMPORT_HISTORY_REQUIRED`.
Missing/incomplete/ambiguous data returns `ORDER_IMPORT_HISTORY_INVALID`; query
failure is the static `ORDER_IMPORT_HISTORY_UNAVAILABLE`. Raw SDK errors, SQL,
parameters and publication contents are not logged or returned. The shared query
resource label is `order-import-history`.

## Immutable complete publication

This contract permits exactly one immutable generation per terminal job. The
manifest lookup does not select an arbitrary latest version. Two publications,
even for the same generation, fail closed. A view must expose every publication
for the job; it must not hide conflicts with a latest-only reducer. Thus separate
numeric pages cannot silently switch mutable generations. An intentional
correction requires a new reviewed contract/reconciliation procedure, not
rewriting the published job while serving old cursors.

The complete source snapshot/checkpoint must cover the terminal job transaction
and all its rows. Source snapshot time is at least completion time, CDC watermark
is at least that snapshot and publication is at least the watermark; future
publication is bounded to clock skew. Background CDC apply time is not proof of
source completeness. An immutable old job does not need a newly timestamped
publication every day: the current writer anchor and permanent immutable
publication must still match. This is a per-job metadata snapshot, not a global
financial warehouse snapshot claim.

The reader requires independent source/warehouse public-job hashes, public-result
hashes and row counts. It recomputes both hashes from the actual selected
projection. Total rows, distinct sequences/first CSV rows/operations, distinct
imported order IDs/receipt IDs, contiguous sequence 1..total, all terminal-state
counts, zero invalid rows and the complete distinct store/counter set must match
the frozen writer anchor. These checks include rows outside the requested page.
An imported row requires exact order/receipt/business date and no error. Failed
and cancelled rows cannot pretend to have financial IDs; error codes are static
source queue codes. Backdated business dates remain intact and are not replaced
by job completion dates.

Each returned page also carries an internal row digest that is independently
recomputed in TypeScript before stripping it from the public response. The
expected page length and sequences are checked. A verified empty tail is valid;
a missing first page, empty whole job, duplicate rows or missing publication does
not become a fabricated zero.

## Exact hash and schema contract

The review-only table schema is
`tools/legacy-order-imports/history-publication.review.sql`. It targets prefixed
resources in the existing reader-authorized raw dataset, not an assertion that
these tables exist. Another dataset needs an additional reader grant. No DDL,
source write, export or source-row query was applied by this slice. The supplied
service account remains read-only. A separate publisher must copy only the
allowlisted fields, verify source completeness and publish the manifest last.
Rewrite queue tables/views were not present in the prior raw inventory; no
unrelated legacy table is substituted as an alias.

Queue DATETIME(3) values are explicitly UTC by the new repository's `sqlTime`
contract; published timestamps are UTC TIMESTAMPs. Canonical hash timestamps use
`YYYY-MM-DD HH:mm:ss.SSS`. IDs and hash count fields are decimal strings in the
canonical arrays. The unsigned BIGINT job sequence is a STRING in the projection,
preserving values through 18446744073709551615 without numeric coercion. Row
sequences/counts stay bounded safe integers. Other native IDs remain canonical
positive signed 64-bit decimal strings.

`jobHash` is SHA256 of UTF-8 compact JSON for this ordered string/null array:
`[pos-order-import-job-v1,id,sequence,actorId,requestHash,kind,state,totalOrders,importedOrders,failedOrders,cancelledOrders,errorCode,createdAt,updatedAt,completedAt]`.
Each `rowHash` uses
`[pos-order-import-result-v1,jobId,actorId,requestHash,jobCreatedAt,jobUpdatedAt,sequence,firstRow,operationId,storeId,counterId,state,orderId,receiptId,businessDate,errorCode,updatedAt]`.
The full result hash is SHA256 of lowercase row-digest hex strings in numeric
sequence order, joined with one LF and no trailing LF. Null values are JSON null.
TypeScript and actual BigQuery hash construction are checked together.
`legacyOrderImportHistoryHashes` is a canonicalization helper, not permission to
assert completeness or evidence of native financial authority.

No encrypted payload, reference, CSV, email/name/address/message, claim token,
request ID, or financial proofHash is projected/returned. Public results are
exactly sequence/firstRow/operationId/storeId/counterId/state/orderId/receiptId/
businessDate/errorCode/updatedAt. Query predicates and keysets are bound, table
identifiers are validated, and SELECT columns are explicit. Clustering by job ID
and generation keeps the bounded whole-job proof independent of all-table scans;
real projection size/cost and pipeline deployment still require qualification.

## Focused evidence

`tests/legacy-order-imports/history.test.ts` covers full native anchors/private
field stripping, fullwidth IDs, all terminal count branches, keyset pages and
empty tails, missing/duplicate/incomplete publications, checkpoint ordering,
whole-job conservation, scope and digest mismatches, public field rejection,
disabled inputs and safe failures. No source or provider mutation is called.

`tools/legacy-order-imports/history-bigquery.ts` executes only generated-literal
SELECTs with the shared parameter normalizer, unchanged byte cap and existing
read-only credentials. It proves exact BigQuery/TypeScript hashes, paging and
negative empty/altered/hidden-row cases without reading source rows. Its evidence
is `parity/evidence/legacy-order-imports/history-bigquery.json`; it is not live
projection or pipeline acceptance. BigQuery literal fixtures use an explicit
singleton FROM before a false WHERE, since BigQuery rejects WHERE on a SELECT
without a FROM clause.

Focused strict configuration is
`tools/legacy-order-imports/history.tsconfig.json`. Root owns repository/API/env/
verifier wiring; this slice does not edit those files or start a shared build.

The focused checkpoint passed 12 unit cases and 12 actual BigQuery generated-literal cases. Owned strict type checking and lint are required before the handoff; source/provider/database writes and shared builds are outside this slice.
