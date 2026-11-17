# Public order browsing and source-order copy history

This slice corrects unrestricted primary-reader access in `modules/orders.ts`. It preserves the existing public eight-column order DTO and detail/HasProduct projection. Its differential baseline is rewrite commit `b90b4be`; a VM executes that exact prior module against the same isolated native fixture. The separate POS-source oracle executes `AjaxOrderListView.datatables` filtering at `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` with an instrumented synthetic ORM. It proves the source's explicit timestamp predicate and store association, not all original datatable columns/search/filter/formatting behavior.

Routing is explicit:

| Selection                                | Facts reader                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Omitted dates                            | Current configured business day, PRIMARY                                        |
| Today, `intent=interactive`              | PRIMARY                                                                         |
| Today, `intent=report`                   | DATA                                                                            |
| Earlier day or mixed earlier/today range | Entire request BIGQUERY                                                         |
| Unknown-age direct detail link           | Date-bounded current read; if absent, BIGQUERY strictly before today's boundary |

Dates are inclusive calendar dates (`from`, `to`), translated to half-open source DATETIME bounds. Both dates are required together; future/reversed/ranges over 62 calendar days fail. This new calendar-date UI is distinct from the original datatable's minute-resolution timestamp picker. An explicit current-day detail never silently widens into history. No historical MySQL fact is read even to classify an unknown-age link. Native authority lookups are current permissions, not historical fact fallback. Deployment must verify `BUSINESS_TIMEZONE` against source DATETIME wall-clock semantics.

`ordersService(db, config, history?, clock?)` keeps existing argument positions and accepts a final selection in `list(user,store,before,limit,selection?)` / `detail(user,store,order,selection?)`. Before and after reading it checks writer-current role/type/account/authentication version and store access/assignment, with no native locks across warehouse HTTP. Archived stores retain historical identity; browsing does not enable inventory/payment operations. Current detail header/lines share an actual RR READ ONLY native transaction; its first SELECT establishes the snapshot. Financial/payment/cancellation/invoice actions continue to perform their independent current writer proofs and do not authorize from warehouse `isPaid` or prices.

The shared application now injects the configured history reader into `ordersService` and the copy-facts adapter. `registerPublicOrders` parses `orderListQuery` and `orderReadSelection`, forwards the complete selection, then requires `request.authSessionValid()` after the await and before returning. A failed/revoked or missing session validator returns 401 even if a historical response completed. Nine shared-route/adapter checks cover selection, input rejection, exact IDs and withholding results after revocation. Query/body/customer data and raw SDK/native exceptions are never exposed in traces.

All IDs stay decimal strings, including values above 2^53. Every source OrderStore association survives. Ordering is `(Order.id DESC, OrderStore.id DESC)`; a scope-bound HMAC cursor preserves duplicate-association pagination, where the former order-ID-only cursor skipped remaining rows for the same order. Its scope includes original operator/store/dates/read intent/reader, immutable generation and expiry. A changed scope, expired/malformed signature or unretained/stale generation requires refresh. The public row adds `rowId` while preserving original fields/values. Native fixture comparisons remove only that additive key/metadata; monetary/name/status fields match the prior projection exactly.

The frontend OrdersPage adds date selection and source/freshness indication, scopes request/cache keys by actor/store/date, and retains source scope in details opened from a list. Unknown-age deep links omit invented dates so the backend can perform bounded classification. Loaded offline views are explicitly informational. The existing payment/invoice/cancellation components remain mounted and enforce their own live capabilities. No shared hook/schema/client/root entry file was edited.

## Qualified warehouse publication

Environment options are owned by `readOrderHistoryOptions`:

| Variable                             | Contract/default                                  |
| ------------------------------------ | ------------------------------------------------- |
| `ORDER_HISTORY_CONTRACT`             | exact `pos-public-order-history-v1`               |
| `BQ_ORDER_HISTORY_HEADERS_VIEW`      | explicit validated fully qualified object         |
| `BQ_ORDER_HISTORY_STORES_VIEW`       | explicit validated fully qualified object         |
| `BQ_ORDER_HISTORY_LINES_VIEW`        | explicit validated fully qualified object         |
| `BQ_ORDER_HISTORY_PUBLICATIONS_VIEW` | explicit validated fully qualified object         |
| `ORDER_HISTORY_MAX_LAG_SECONDS`      | 300; bounded 30–86400                             |
| `ORDER_HISTORY_MAX_ORDER_LINES`      | 10000; bounded 100–50000; never silently truncate |

`tools/order-history/publication.review.sql` specifies review-only tables in the already-authorized `tssgcp2025.tss_mysql_raw_layer`, avoiding an implied grant to a new dataset. The supplied account remains read-only; no DDL/load/export/view/UDF was executed. These curated objects and independent publication pipeline are deployment requirements, not facts inferred from existing raw tables.

A generation must contain one normalized header per order, every physical OrderStore row and every physical HasProduct row (with LEFT JOIN product-name enrichment). Store-day manifests include independently captured source counts and two-level ordered SHA-256 over the exact joined rows, plus matching warehouse counts/hash. Every selected day needs a manifest, including zero-result days; empty SQL results alone never become a fabricated empty report. Per-order manifests independently conserve complete header/association/line counts plus full and minimal-copy hashes. Missing, duplicated, mixed/stale/future, incomplete, mismatched or changed publications fail closed. Source completeness requires a verified common authoritative source checkpoint across orders/store rows/HP/products/status lookups; CDC background apply time alone is insufficient.

Digest encoding is `-` for SQL NULL, or `+` plus lowercase UTF-8 hex for each string, joined with `|`, then SHA-256. Digest rows are grouped in ordered chunks of 100; each chunk SHA-256 uses LF-separated row digests, and the final SHA-256 uses LF-separated chunk digests. Empty streams hash the empty string. Exact field/purpose/order is in `hashes.ts`; fixed ordering prevents duplicate/SKU collapse and bounded chunks avoid concatenation truncation or oversized single group strings. Native float values must be normalized with the same MySQL driver/ECMAScript number-to-string behavior; generic BigQuery FLOAT casting is not assumed identical.

Public point reads first verify a small integer-sharded order manifest. They then bind its immutable generation, snapshot ID and business date into a separate fact query with constant partition filters. Both query estimates share one cumulative `BIGQUERY_MAX_BYTES_BILLED` budget; execution retains the existing hard billing/time guard and never raises the configured cap. This avoids relying on dynamic join-derived partition pruning. Google documents that [partition pruning needs a qualifying constant filter](https://docs.cloud.google.com/bigquery/docs/querying-partitioned-tables#best_practices_for_partition_pruning), and [clustered-table cost cannot be accurately established before execution](https://docs.cloud.google.com/bigquery/docs/clustered-tables). Actual publication workload/cost acceptance is still required; synthetic zero-byte jobs are not a live latency claim.

## Minimal copy-facts service port

```ts
publicOrderHistory(config, options?, dependencies?).copyFacts({
  source: {kind:'store',storeId} | {kind:'customer',customerId},
  orderId,
  cutoff: /* current server business-day start in source DATETIME */
})
```

Returns `{orderId,sourceCustomerId,createdAt,source,reader:'bigquery',fetchedAt,generationId,complete:true,lines:[{lineId,productId}]}`. Store mode requires the exact complete OrderStore association. Customer mode requires exact `orders.user_id` and does not invent store/HL/Express whole-order authority. It selects no names, contacts, old prices, quantities, benefits or Product columns. It uses native `HasProduct.prod_id`, preserves every distinct HP row and duplicate SKU, and never expands quantity. Unavailable/missing catalog products remain in the facts so the target cart can resolve them under current selling rules. The consumer must capture/recheck writer-current source/target permissions, connected customer, target check-in and checkout lease. The reader is not that mutation authority. Checkout's stricter 500-line target limit may reject a larger complete source; it must not truncate.

## Verification and limits

Scoped commands (Node 24 LTS, no project dependency install):

```sh
ORDER_HISTORY_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_order_history_test \
  node node_modules/vitest/vitest.mjs run --config tools/order-history/vitest.config.ts
node node_modules/typescript/bin/tsc -p tools/order-history/backend.tsconfig.json
```

Frontend: `vitest run --config tests/order-history/vitest.config.ts`, `tsc -p tests/order-history/tsconfig.json`, and `node tests/order-history/browser-check.mjs`. The controlled Chromium program uses a loopback ephemeral port, worktree-local caches and synthetic API responses. It preserves duplicate rows, explicit date requests, selected detail dates and unknown-age direct-link behavior. It sends no mutations/provider requests and closes browser/server.

The MySQL fixture validates an exact localhost template and creates/drops only randomized isolated schemas from verified physical metadata/defaults. It executes the prior pinned module, preserves FLOAT/BIGINT/NULL and orphan-product behavior, exercises all three routing branches, duplicate pagination, absence classification, missing publications and assignment revocation during warehouse work. The native EXPLAIN case checks candidate-index syntax/eligibility and response equality on a small fixture; it is not a production performance benchmark.

`tools/order-history/bigquery.ts` substitutes only generated literal CTEs for every configured object, rejects any remaining dataset table reference, and runs the real SELECT/reducer with a synthetic >100-row digest boundary, Unicode/quotes, full-width IDs and valid/corrupt publications. It never selects source rows. Its private-output regression supplies a synthetic credential-bearing SDK error, captures stdout/stderr and proves only a static resource/stage/code is emitted; no SDK object/message/header/body/cause is serialized.

This slice does **not** certify the whole original `AjaxOrderListView`: its existing additional order-type/global/queue/mobile/email/payment/status/search/sort and detailed formatter columns are outside the eight-column rewrite projection tested here. Treat those original source surfaces separately in the overall feature inventory rather than marking this routing patch as full datatable parity.

Focused checkpoint: 35 backend checks (including six native MySQL cases), two frontend unit checks, five controlled Chromium checks, both strict programs/lint, and six executed GCP synthetic valid/corrupt SELECT cases. The GCP aggregate was zero source rows and zero estimated bytes; it covered the separate manifest, full detail and minimal-copy paths with the actual SDK parameter normalizer. No source-table query, external mutation or production DDL was used.
