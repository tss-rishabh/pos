# CSV membership: qualified BigQuery history

This slice implements the read-only history reader and pre-dispatch handoff for
`pos-legacy-import-membership-v1`. It does not deploy a source publisher,
warehouse projection, private transport, or production membership profile. All
financial dispatch and source-profile integration remain explicit prerequisites.
No source repository, database row/schema, provider, or infrastructure was
modified during verification.

## Source rules

The pinned `backend-tss-api_v2/controllers/cart/Cart.py` SHA-256 is
`1f9eff0f1a4ea66f3cac8903d3c1cb9a5b39e2a3babd6dd6c8dcf192de7defd3`.
`AddFreeMembership.check_criteria`, lines 636–707, executes these three shapes:

1. Latest order for the customer with `order_status=3`, `created_at DESC LIMIT 1`.
2. The customer's delivered orders with `created_at>date_before`, descending.
3. `prod_id,is_exclusive_order` for the selected order's has-products rows.

There is no payment-status, line-status, return, exchange, or store filter. The
reader adds none. The historical source query for the most recent order has no
date lower bound. The 45-day query uses the source's **execution-time naive
`datetime.now()`**, subtracts 45 calendar days and formats seconds. It does not
use the CSV order date. Source-process timezone must be verified independently;
`BUSINESS_TIMEZONE` and explicit Kolkata timestamps elsewhere in API-v2 are not
proof of that process's naive clock configuration.

The source returns true immediately for `cart_value>2000`. Otherwise it skips
membership product IDs while finding the first ordinary line. Its assignment is
literally `False if is_exclusive_order==1 else True`. That inversion is retained.
An all-membership/empty-HP order leaves the flag false. A latest delivered DCC
order (method 10) can qualify even outside 45 days; otherwise only the first recent
order is inspected although the full recent SELECT is represented. Equal order
timestamps and mixed ordinary flags are refused because the original SQL does
not determine a first row. The reader does not silently pick a convenient order
or turn incomplete/ambiguous history into no history.

`constants/StatusEnum.py` is pinned independently to
`42cb694ff628c61ef8a5ec169a4b319a8c1491ef2a698f93665348e6b22d0a06` for DCC 10.
The source oracle compiles the complete actual `AddFreeMembership` class and
actual payment enum; it executes the unmodified criteria method against native
fixture facts and the existing Python `HistorySession`. Node/Python document
HMACs are checked against each other.

## Callable integration

New modules:

- `src/modules/legacy-order-imports/membership-profile/bigquery.ts`
- `src/modules/legacy-order-imports/membership-profile/bridge.ts`

```ts
const options = readCsvMembershipBigQueryOptions(environment);
const history = csvMembershipBigQueryHistory(options, {
  historyKey, // retained private document/prefetch key
  publicationKey, // distinct trusted source-publisher key
  memberProductIds, // actual source MEMBERSHIP_PROD_ID values
});

// OUTSIDE SQL, BEFORE journal.dispatch('order') / order nonce allocation:
const request = requestForCsvMembershipDispatch(
  { operationId, requestHash, planHash, customerId },
  { sourceTimeZone },
);
const handoff = await prefetchCsvMembershipHistory(history, request, {
  historyKey,
  memberProductIds,
  sourceTimeZone,
  maxLagSeconds: 60,
});

// Retain handoff under the original operation and bind its capability digest
// into the later signed source request. This is server material, never a
// browser-supplied facts document. No new nonce/source POST on lost reply.
assertCsvMembershipPrefetch(handoff, request, {
  historyKey,
  memberProductIds,
  sourceTimeZone,
});
const memoryOnly = inMemoryCsvMembershipHistory(handoff, {
  historyKey,
  memberProductIds,
  sourceTimeZone,
});
// memoryOnly.read(request) performs parsing/HMAC/time checks, with no I/O.
```

The reader implements the existing `CsvMembershipHistoryPort.read(request)`.
Its factory also accepts injected `query`, `clientFactory` and `clock` for
isolated tests. The default SDK uses ADC; `GOOGLE_APPLICATION_CREDENTIALS` may
point to the authorized reader JSON. Only the Google SDK opens the file. The
module does not read, copy, inspect, print or retain credential bytes.

The prepared object is exactly `{document,capability}`.
`document` is the existing `QualifiedCsvMembershipHistory`.
`capability` has contract `pos-csv-membership-prefetch-v1`, strict request scope,
source timezone, generation ID, purpose-HMAC document digest, expiry and its own
purpose-HMAC signature. The document already binds customer, operation, original
request/plan hashes, asOf, cutoff and generation. Expiry is at most the source
point plus the configured lag, and at most fetchedAt+60 seconds. Neither replay nor
recovery extends it. The in-memory port copies and freezes its retained input.

Root must attach this immutable handoff **before** committing source order
dispatch. A missing/stale/over-budget publication is pre-dispatch no effect,
not a fictitious unknown source stage. If a Node reservation already exists,
retain the appropriate Node-local no-effect outcome under its original UUID.
The source evaluator must verify the handoff/capability and freeze **only the
membership eligibility clock** to `request.asOf`, not change the imported order
date or other financial timestamps. The source `HistorySession` then replays
the signed document in memory. A TypeScript async reader is not a synchronous
Python in-transaction BQ adapter. No SQL transaction may call BQ/HTTP or attempt
a historical MySQL fallback.

Requests must use the exact retained source execution point. A publication for
another point, even one second earlier, is not relabeled as the current one.
An on-demand source publication or an independently verified retained execution
point is necessary; an arbitrary old snapshot/business date is insufficient.
An already dispatched/unknown source stage remains original GET recovery and
must not acquire a new snapshot/capability to repeat financial work.

## Options and bounded SDK behavior

All optional blank environment placeholders are treated as unset. There is no
enabled default, credential logging, HTTP route, new worker or MySQL migration.
Root owns app/env/transport wiring.

| Option                                | Default / limit                                           |
| ------------------------------------- | --------------------------------------------------------- |
| `CSV_MEMBERSHIP_BIGQUERY_CONTRACT`    | unset; select `pos-csv-membership-bigquery-v1` explicitly |
| `BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW` | required when selected                                    |
| `BQ_CSV_MEMBERSHIP_ORDERS_VIEW`       | required when selected                                    |
| `BQ_CSV_MEMBERSHIP_LINES_VIEW`        | required when selected                                    |
| `CSV_MEMBERSHIP_SOURCE_TIMEZONE`      | required, verified source IANA timezone                   |
| `CSV_MEMBERSHIP_MAX_BYTES_BILLED`     | 50,000,000; max 1,000,000,000                             |
| `CSV_MEMBERSHIP_QUERY_TIMEOUT_MS`     | 8,000; max 10,000                                         |
| `CSV_MEMBERSHIP_MAX_ORDERS`           | 1,000; max 5,000 selected unique orders                   |
| `CSV_MEMBERSHIP_MAX_LINES`            | 10,000; max 10,000 selected unique lines                  |
| `CSV_MEMBERSHIP_MAX_LAG_SECONDS`      | 60; max 60                                                |

All three distinct view identifiers must be in
`tssgcp2025.tss_mysql_raw_layer`. The SDK project is fixed to `tssgcp2025`, location
`asia-south1`. Values use explicit bound types and the shared SDK temporal
normalizer. IDs remain canonical signed-positive INT64 strings, including values
above 2^53. Dry-run referenced tables must stay inside the allowed dataset and
no referenced routine is accepted. Missing reference/billing metadata fails
closed. The installed SDK's actual DATETIME parameter serialization is tested.
The producer follow-up adds a required `scope_shard` INT64 column to every
projection/control table, derived as exact `customerId % 1024`. All query paths
bind it explicitly so reviewed range partitions can prune before scanning.

One dry-run and one complete snapshot statement share a total deadline and byte
budget. Both local and SDK deadlines are bounded; retry/automatic pagination are
disabled, partial pages/jobs are refused and known late jobs are cancelled. The
driver accepts only the exact generated SELECT definition and typed bounds.
SQL counts all delivered headers, checks ID uniqueness, selects latest/45-day
headers, diagnoses future/null/subsecond dates and limits materialized rows to
bound+1. Lines are joined only for bounded selected headers; the complete count,
uniqueness, customer scope, source/warehouse hashes and local selected digest are
then verified. An actual boundary overflow refuses the document, not a partial
history. Wire JSON is capped at 2 MB; the existing complete signed document remains
capped at 1 MB and 20,000 represented lines including repeated latest-order data.
Projected strings are capped at their schema limit+1 inside SQL, so oversized
invalid view values remain detectable without an unbounded response body.
Raw SDK/query/env/credential errors are suppressed behind static resource codes.

## Required publication contract

These are normalized **immutable generation** projections, not aliases for the
live raw CDC tables. Headers contain all relevant source-customer orders at the
source cut. HP projection includes the full selected order line sets. The
source and warehouse must independently compute matching counts/digests before
the trusted publisher signs completeness, including a proven empty customer.

Orders-view columns:

| Column                                     | Type                              |
| ------------------------------------------ | --------------------------------- |
| `generation_id`, `customer_id`, `order_id` | STRING                            |
| `payment_method`, `order_status`           | INT64                             |
| `created_at`                               | DATETIME, exact source wall value |

Lines-view columns:

| Column                                                              | Type                                |
| ------------------------------------------------------------------- | ----------------------------------- |
| `generation_id`, `customer_id`, `order_id`, `line_id`, `product_id` | STRING                              |
| `is_exclusive_order`                                                | INT64,0 or1; no null-to-zero repair |

Publication-view columns:

| Column                                                          | Type / rule                                 |
| --------------------------------------------------------------- | ------------------------------------------- |
| `contract`                                                      | STRING `pos-csv-membership-publication-v1`  |
| `generation_id`                                                 | STRING 64 lowercase hex, immutable          |
| `customer_id`                                                   | canonical positive INT64 STRING             |
| `as_of`, `cutoff`                                               | DATETIME second; cutoff=asOf−45 wall days   |
| `source_time_zone`                                              | exact configured IANA STRING                |
| `source_snapshot_id`                                            | immutable opaque STRING 16–128              |
| `source_snapshot_at`                                            | TIMESTAMP, exact source asOf instant        |
| `source_cdc_through`                                            | TIMESTAMP≥source snapshot                   |
| `published_at`                                                  | TIMESTAMP≥CDC through,≤reader clock         |
| `source_complete`                                               | BOOL, must be true                          |
| `source_order_count`, `warehouse_order_count`                   | INT64 all delivered customer headers        |
| `source_selected_order_count`, `warehouse_selected_order_count` | INT64 unique latest/recent selected headers |
| `source_line_count`, `warehouse_line_count`                     | INT64 all selected unique HP rows           |
| `source_history_hash`, `warehouse_history_hash`                 | 64hex independent selection digests         |
| `signature`                                                     | 64hex trusted source-publisher HMAC         |

`csvMembershipSelectionHash(request,selection)` specifies the plain SHA-256
canonical bytes, with kind `legacy-order-imports.membership-selection.v1`, input
`{customerId,asOf,cutoff,lastDeliveredOrder,recentDeliveredOrders}`. Order headers
are descending by their original wall timestamp; HP rows are numeric-PK
ascending, which preserves source decisions only after the ordinary-flag
ambiguity guard. Latest is repeated as the first recent order when inside the
window. The independent source reducer must not derive its expected digest from
the warehouse output. Its count for all older delivered headers also proves
whether any latest order exists.

`csvMembershipPublicationHash(body,publicationKey)` specifies the manifest HMAC,
kind `legacy-order-imports.membership-publication.v1`. Strict camel-case schema
is exported as `csvMembershipPublicationSchema`; SQL maps the snake-case view
fields to those exact signed names. Timestamps in the signed body use the exact
UTC 6-fraction representation returned by the query. Source and warehouse count
fields are signed decimal strings in that body. Do not include `signature` in
the body passed to its hash helper. Both retained keys are distinct printable
ASCII 32–4096-byte server secrets. They are never published to BQ or the browser.

## Remaining code versus deployment

**Implemented here:** bounded SDK reader, exact reducer, independent manifest
checks, document signing, expiring immutable prefetch capability, no-I/O replay,
source/dry-run/negative tests and callable root hooks.

**Producer code implemented in the follow-up:** native source-authenticated
read-only snapshot capture, independently queried warehouse candidate reader and
verified manifest sealer are in `publication-native.ts`,
`publication-transaction.ts`, `publication-warehouse.ts` and `publication.ts`.
See `membership-history-publication.md` for real native/negative tests and exact
hooks. This is a retained snapshot/control seal; it does not invent a continuous
native writer-revision/head or claim that source/warehouse deployment occurred.

**Remaining root integration CODE:** pre-order-dispatch preparation and durable
handoff retention, later private capability/document-digest binding, source-side
capability verification and membership-only frozen clock/replay. None may be
implemented as BQ/HTTP under SQL locks. Root owns these files.

**Warehouse deployment/data acceptance:** the saved metadata discovery in
`evidence/bigquery-schema.json` contains raw `tss_orders`/`tss_has_products` with
DATETIME created_at and independent CDC metadata; it does not establish any of
these normalized generation projections or completeness manifest. The recorded
raw tables' 1-hour max-staleness setting is not a source seal or a 60-second
complete history. No real publication has been read/accepted by this slice.
Source timezone, trusted publisher ownership/key, source/warehouse independently
computed proofs, full current source consumers and real profile roundtrip remain
deployment acceptance work. Missing any prerequisite is an error, never empty
history, an old MySQL read, or an automatic membership decision.

## Verification

From `backend/` with the pinned Node 24 runtime:

```sh
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tools/legacy-order-imports/membership-bigquery.tsconfig.json
npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/legacy-order-imports/membership-bigquery.test.ts tests/legacy-order-imports/membership-bigquery-sdk.test.ts tests/legacy-order-imports/membership-bigquery-source.test.ts tests/legacy-order-imports/membership-bridge.test.ts --maxWorkers 2
```

The source oracle requires Python 3 stdlib and the pinned read-only sibling
`backend-tss-api_v2`; it imports no live app, SQL driver, message/provider SDK or
customer data. Tests use fake SDK jobs/query results and synthetic fixtures.
The focused run passed 65 Vitest cases, including one oracle test that executes
16 literal-source vectors. Scoped strict TypeScript, lint and `git diff --check`
also passed. These are reader/bridge checks, not a deployed financial workflow
certification.

Optional compile-only check, explicitly authorized read-only SDK path:

```sh
GOOGLE_APPLICATION_CREDENTIALS=/Users/rishabhbhatia/Downloads/reports-bigquery-reader.json npx -y node@24.22.3 --import tsx tools/legacy-order-imports/membership-bigquery-dry-run.ts --live
```

Without `--live` the command exits disabled without constructing an SDK client.
With it, all configured-view references are replaced with generated literal CTEs
and only `dryRun:true` is submitted. Complete and signed-empty query shapes both
compiled on the authorized BigQuery project/location, estimated bytes 0 each.
No customer/order rows were queried; no query executed, no external tables were
created and no credential bytes were inspected/copied/printed. The dry run is a
SQL/type qualification, not proof that any real publication/profile is deployed.
