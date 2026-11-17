# Bounded BigQuery coupon history

The runtime couponBigQueryHistory implements CsvCouponHistoryPort.read(scope, {witness, signal}) for the five literal coupon queries in API-v2 2960acbea10c4eaf16b6d99e15ff6e03ef7724c5. It reads only dedicated immutable BigQuery projections in tssgcp2025.tss_mysql_raw_layer, location asia-south1. It has no database handle, native history fallback, raw CDC fallback, or assumed empty-history path. Construction performs no SDK, credential or database I/O.

The source all-writer/late-head fence is a separate required participant. The reader recomputes couponHistoryControlHeadHash with the retained source proof key, checks the current imported writer-definition hash, and requires matching signed capture and publication. The caller must still check that same witness after the awaited read inside its pre-source transaction; the reader cannot prevent a later source mutation alone.

## Exact facts

| Fact             | Preserved source behavior                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global usage     | Every customer's matching coupon; excludes 0/4/7/15/17/22/31/33; no order-date upper bound.                                                                      |
| Today's usage    | Target customer+coupon; source local calendar day; excludes 0/17; already-present future hours today count.                                                      |
| First-user count | All target-customer orders except 0/17; any coupon/date, including future orders.                                                                                |
| Monthly usage    | Current source-month active logs joined to all eligible orders on user+coupon, **not log.order_id**; multiplication retained; order date unbounded.              |
| Lot counts       | Same multiplicative user+coupon join, active logs of any date; native lot equality/nonempty predicate, exact decoded code equality, original allowance counters. |

The query groups primitive order/log rows and multiplies counts using BIGNUMERIC, returning canonical decimal strings. Copied native usage-count columns are never warehouse facts. SQL NULL predicates are retained. Overflow beyond the existing 19-digit count schema fails closed. Native IDs remain canonical signed INT64 strings, including IDs above 2^53.

Synthetic vectors include 3 monthly logs multiplying 4 eligible orders into 12 uses, 4 all-time logs producing 16 lot uses, another customer's future global use, future hours today, old/future first-user/lot records, status/NULL differences, zero/orphan coupons and case/trailing-space comparisons.

## Native comparison controls

The qualification/publisher-only couponWarehouseSourceControls(db, {sourceKey, comparisonFingerprint}).capture(signedCapture) has an owned read-only repeatable-read snapshot. It checks server/schema identity, unchanged three heads and target input hash, plus actual participating trigger bodies. It captures the complete distinct coupon IDs referenced by the customer's orders/logs plus target, including zero/orphans. It is never a runtime eligibility port.

Its signed manifest binds scope, generation, capture, snapshot, head, target input hash, sorted control rows/hash/count (canonical chunks of 1,000, with total/count and ordered chunk hashes authenticated by the outer HMAC) and actual type/charset/collation/PAD_ATTRIBUTE metadata for coupon_lot_no and voucher_code. The physical fixture is latin1_swedish_ci / PAD SPACE. Configuration pins the approved metadata fingerprint. Native case/PAD SPACE lot equality can coexist with false exact decoded-code equality. Native SQL exports flags/allowances/opaque IDs only; no raw code or lot enters BQ parameters, artifacts or diagnostics. No LOWER approximation is used.

The attester bounds controls to 10,000 IDs before signing; malformed/NULL native allowances, missing heads/triggers, changed metadata and incomplete sets fail closed. It never changes rows or fabricates a present coupon.

## Candidate and publication workflow

The review-only physical schemas and primitive projection selections are in tools/legacy-import-coupon-history/warehouse.review.sql; these are not automatic migrations. Five distinct views are configured: candidates, publications, orders, logs, controls.

1. Existing NativeSourceCapture attests the actual five SELECT results with original clock/timezone and qualified native heads.
2. Capture signed comparison controls against those same heads. A relevant concurrent write requires fresh capture/generation.
3. An independently authorized publisher supplies immutable complete order/log projections and exact signed controls. Orders contain the union of all target-customer orders and all target-coupon orders across customers. Logs contain all target-customer logs. Neither projection has an asOf cutoff. Per-table CDC timestamps alone cannot establish a coherent native snapshot.
4. After all projection rows are durable, append one complete candidate matching operation/request/plan/customer/coupon/configuration/asOf/timezone/head/generation/snapshot, source/control documents and coherent CDC-through.
5. couponWarehouseCapture(options, {sourceKey}, dependencies).read(capture, {signal}) dry-runs then independently queries candidate facts. It verifies native identities, duplicates, coverage, signed controls, bounds and completeness.
6. sealCouponWarehousePublication(capture, candidatePort, {sourceKey, publicationKey, historyKey}, {signal, clock}) compares actual warehouse facts to signed native facts and emits a signed publication artifact. It performs no cloud write.
7. A separately authorized publisher appends one immutable publication row. Runtime recomputes the five facts and verifies publication/current witness before returning the existing qualified history document. Missing, duplicate, mixed, stale or tampered evidence never becomes zero.

The read-only tools/legacy-import-coupon-history/seal-publication.ts --seal-candidate accepts one bounded signed native capture on stdin and emits the independently verified signed publication on stdout. It reads the three purpose keys from CSV_COUPON_SOURCE_PROOF_KEY, CSV_COUPON_PUBLICATION_KEY and CSV_COUPON_HISTORY_KEY; ADC and the configured candidate/projection views supply read access. It performs no warehouse write and prints only a static failure on invalid/private input.\n\nNo publication pipeline is deployed by this slice. A raw CDC alias, manually asserted complete flag, or copied native count row cannot qualify it. Actual complete generation builder/publication deployment and bounded query plans must be accepted before enabling the selector.

## Integration

New exports:

- history-bigquery.ts: couponBigQueryHistory(options, {sourceKey, publicationKey, historyKey}, {query?, clientFactory?, clock?}).
- history-warehouse-contracts.ts: readCouponBigQueryOptions(env), schemas, comparison fingerprint and signed controls verification.
- history-warehouse-source.ts: qualification-only native controls attester.
- history-warehouse-publication.ts: candidate read/sealing helpers.
- history-warehouse-query.ts: branded frozen generated SELECT; arbitrary/cloned statements cannot enter the production SDK adapter.

All three purpose keys are distinct ASCII secrets. The source-control/witness key is the existing retained source proof key; publication and qualified-history keys stay separate. No key is returned/logged.

Options: CSV_COUPON_BIGQUERY_CONTRACT=pos-csv-coupon-bigquery-v1; BQ_CSV_COUPON_{PUBLICATIONS,CANDIDATES,ORDERS,LOGS,CONTROLS}_VIEW; CSV_COUPON_COMPARISON_FINGERPRINT; CSV_COUPON_SOURCE_TIMEZONE. Optional bounds: max billed bytes default 50MB/hard max 1GB, query timeout default 8s/hard max 10s, controls 10,000, lots 1,000, lag 60s. Blanks are unconfigured. Root owns app/env/runtime registration; this slice changes none.

One deadline covers estimate+execute with caller abort, strict DATETIME parameters, validated referenced project/dataset/routines/schema, and a consumed dry-run estimate. SDK initialization is lazy; retries/cache/pagination disabled. Late-created or hung jobs cancel once. Results must be one JSON string row, at most 1.5MB UTF-8; signed nested documents at most 262,144 bytes. Errors contain static codes, including SDK credential/header/body/cause failures.

## Validation

```sh
npx --offline node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tools/legacy-import-coupon-history/bigquery.tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run tests/legacy-import-coupon-history --maxWorkers=1
BQ_COUPON_HISTORY_VALIDATION_KEY_FILE=/path/to/readonly-key.json npx --offline node@24.22.3 --import tsx tools/legacy-import-coupon-history/bigquery.ts --synthetic
```

The explicit synthetic tool replaces every warehouse view with typed literal CTEs, dry-runs before SELECT, and reads no application rows/writes no objects. Candidate/sealer and published runtime cover literal/zero successes plus duplicate/mixed/missing/overflow/orphan/incomplete refusals. Diagnostics never serialize SDK errors or key files. This qualifies query syntax/typed parameters/arithmetic, not actual CDC completeness or deployment.

Native tests use isolated local MySQL physical schemas, original source predicates and review-only trigger bodies. Protected source schemas, providers, mail, uploads and deployments remain untouched.

Recorded checkpoint: all 94 focused cases pass (57 new reader/SDK/CLI/native-control cases plus 37 source/publication/head regressions), the dedicated strict config and scoped ESLint pass. Actual BigQuery asia-south1 dry-run/SELECT validates all 16 synthetic candidate/runtime cases, including independently executed refusal cases: max estimated bytes 0, source application rows read 0, warehouse writes 0. The empty-data literal fixture uses a typed empty UNNEST relation; production SELECT logic was unchanged by that fixture correction.

Native ESM startup depends on the separately reviewed financial primitive split 357a782; it preserves existing crypto exports/HMAC bytes. Source head support consumes foundation 5058162 and late-head 4f622dc without duplicating their algorithms. Current app/worker registration remains root-owned, and production immutable-generation publication/source-writer acceptance remains unselected.
