# Original order list

This slice ports `order/datatables/orders_datatable.py::AjaxOrderListView` and its active `order/templates/order/index.html` list controls at POS pin `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. It supplements the earlier eight-column public-order reader; `copyFacts` and safe GET list/detail signatures remain unchanged. It does not certify unrelated order-detail/payment/provider writers.

The source lists ST store, HL local, HE Express and N online orders; explicit IDs, store selection, minute-inclusive placement bounds, method/payment/order statuses, mobile/email, numeric ID substring search, queue/not-packed filters, sortable fields, source pagination/counts and all original formatter columns are implemented. `order_amt` is source gross amount, not `pay_amt`. Payment strings retain exact spaces and provider precedence; active created rows are not hidden merely because another completed row exists. Transaction references preserve inactive-attempt count/suffix behavior. FK zero sentinels, orphan-user formatting, first physical store/counter, offline/Shopify/global badges and HasProduct revert flags retain source behavior.

The source issues two distinct reverse-store filter calls. Actual Django 4.2.5/MySQL proves the resulting A×B association multiplicity; the candidate preserves it instead of DISTINCT collapsing orders. Counts after ID search reset BOTH recordsTotal/recordsFiltered, matching source. Out-of-range pages return page 1. Ordering adds deterministic ID/association ties where source leaves ties unspecified. Customer-first-name sorting preserves Django's orphan-dropping page join while counts retain those rows. No source timestamp is fabricated for a missing relation; invalid positive FK/dimension evidence requires reconciliation.

`POST /api/v1/stores/:storeId/orders/searches` is a private read search with validated body and empty query. `GET /api/v1/stores/:storeId/order-search-options` returns current bounded dictionaries/active assigned stores. Root registers `registerOrderSearch(app,config,db,options?,{history?,clock?,service?})`; `service` is an explicit synthetic-only demo/test injection, so DEMO need not connect to source/writer databases. Both routes use static resource traces and recheck `authSessionValid()` after awaited service work. Service authorization rechecks writer-current account role/type/authentication epoch, assignments and check-in before/after asynchronous warehouse work; no SQL locks cross HTTP. Logs never receive body/contact/query data.

The OrdersPage uses the new list component and retains its existing independently authorized detail/payment/invoice/cancellation components. Every source column is available in the view/summary; visible-column export contains exactly the loaded page, preserves duplicate rows and neutralizes spreadsheet formulas. Phone/email remain only in POST body and component memory, never URL/query-cache keys/localStorage. Search cache keys use opaque request UUIDs and actor/store scope. Store actions use the authorized association; HL/HE summaries link their existing operational workspaces. An old list hint never enables financial actions. Global online list eligibility remains the source internal userType 1 policy, without granting arbitrary invoice/payment access.

## Explicit corrections

- Explicit IDs no longer bypass assigned-store ownership. HE IDs must have an actual authorized Express association. Franchise role 1 cannot impersonate internal global visibility.
- For non-global viewers, a split order's display counter/action comes from the first authorized store association, preventing other-store data substitution. Source-normal rows retain their values.
- Queue transfers compare exact JSON store tokens: store 1 cannot match 11. Equal numeric NW location/Store IDs do not prove ownership; `hyperlocal_locations.store_id` must establish the mapping. Unmapped warehouse evidence refuses the queue.
- Default browsing is the current business day. Earlier/mixed selections use BigQuery only. Explicit IDs can omit dates for qualified cross-date lookup; wide unbounded contact searches require explicit dates. This is a visible routing/safety policy, not a claim that unrestricted lifetime MySQL reads remain supported.
- Invalid sort identifiers are rejected instead of executing arbitrary ORM field paths. React escapes text; PII filters are not persisted like the original DataTables state.

Current queue membership/status/owner is operational PRIMARY state. Today facts are date-bounded PRIMARY, today `intent=report` uses DATA, and every older fact is qualified BIGQUERY. Queue dates/IDs are ignored exactly as source; both queue flags intersect. Current membership is revalidated after historical work. Missing old facts fail the entire scoped queue with `ORDER_QUEUE_HISTORY_UNAVAILABLE`; they are never dropped or returned as zero. Current permission/dimension/input-weight reads are not historical MySQL fact fallback.

## Qualified historical deployment

Additional environment options: exact `ORDER_SEARCH_CONTRACT=pos-source-order-search-v1`; explicit `BQ_ORDER_SEARCH_INDEX_VIEW`, `BQ_ORDER_SEARCH_FACTS_VIEW`, `BQ_ORDER_SEARCH_PUBLICATIONS_VIEW`; private `ORDER_SEARCH_CONTACT_KEY` (at least 32 characters) plus `ORDER_SEARCH_CONTACT_KEY_ID`; `ORDER_SEARCH_MAX_LAG_SECONDS` default 300 (30–86400), `ORDER_SEARCH_MAX_INDEX_ROWS` default 20000 (1000–50000), `ORDER_SEARCH_MAX_QUEUE_ORDERS` default 10000 (100–10000).

`tools/order-search/publication.review.sql` is a concrete review-only publication schema/producer contract inside the already-authorized raw dataset. No DDL/view/UDF/load/export was executed. The existing raw CDC tables do not establish this complete multi-table publication. Generation, independent source/warehouse counts and ordered digests, source-complete checkpoint/CDC freshness, contact-key identity, exact scope/day coverage including zero days, index/fact hash conservation and native JSON projection are verified. Missing/stale/mixed/corrupt/oversized evidence fails closed. HMAC comparisons use actual physical MySQL weights (Latin1 Swedish for direct order phone, utf8mb3 general for user telephone/email), preserving accent/case/trailing-space semantics; raw contacts and LOWER substitutes never enter BigQuery parameters.

Index reads have constant date/scope bounds and a strict complete-row bound. Only selected page facts are fetched by bound ID and 8,192 constant order shards. Scope manifests use 1,024 constant shards. Per-request dry-run estimates share the configured BigQuery byte budget across all phases, and execution retains the hard time/billing guard. The reader never raises the cap. Distinct scope copies must agree; independent source counts/hashes prevent missing-as-empty responses. A thin index is filtered/sorted in memory under the explicit bound; ST multiplicity pagination uses arithmetic expansion so large joins are not materialized in memory.

## Evidence

`ORDER_SEARCH_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_order_search_test` creates/drops randomized isolated schemas only. `ORDER_SEARCH_ORACLE_PYTHON` must select a pinned Django 4.2.5/PyMySQL environment; no dependency auto-install occurs. `tools/order-search/source_oracle.py` executes exact AST-extracted original datatable/helper/LegacyForeignKey methods with real Django/MySQL queries and read-only local connections. Source fixtures contain only synthetic data. Native evidence includes 43 source filter/sort/page vectors, full-width IDs, physical collation/HMAC comparison, source join multiplicity, queue token/warehouse ambiguity, current permission revocation and history refusal, plus candidate-index EXPLAIN/equal-response checks. Verified columns/defaults/collations come from saved metadata, including the new eight-table order-list snapshot; no source-row probe was used.

Portable frontend-only CI uses committed `frontend/tests/order-search/source-snapshot.json`, recording the original file SHA256 and source pin. It does not invoke or require a sibling source checkout. The native parity suite checks that snapshot against the actual pinned source; explicit refresh requires `ORDER_SEARCH_REFRESH_SNAPSHOT=1`. Scoped strict programs/configs: `tools/order-search/backend.tsconfig.json`, `tools/order-search/vitest.config.ts`, frontend `tests/order-search/{tsconfig.json,vitest.config.ts,browser-check.mjs}`. Existing five order-history browser checks are adapted to the new read transport while preserving exact date/direct-link checks. The new controlled browser suite uses an ephemeral loopback port and no provider calls, shared dist or default ports.

BigQuery generated-only validation uses the existing committed `tools/order-history/bigquery.ts` privacy boundary with `ORDER_HISTORY_VALIDATION_GROUP=source-order-search`. The captured-output regression throws a synthetic credential-bearing SDK error before client/key access and proves stdout empty plus a static stage/code on stderr. Unknown SDK exceptions are never inspected or stringified. No validation reads a production table or prints source rows. Curated publication availability and production workload acceptance remain deployment prerequisites, not inferred parity certificates.

Focused checkpoint: 31 backend checks, including 13 isolated native cases and 43 original-handler vectors plus explicit source-security correction cases; two portable frontend unit checks; 12 controlled list browser checks and five retained date/direct-link browser checks; both strict programs and owned lint. Four executed GCP synthetic range/point/verified-empty/corrupt cases read zero source rows and estimated zero bytes. The six previously accepted generated history cases also remained green. These are scoped results, not production workload certification.

```sh
ORDER_SEARCH_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_order_search_test \
  ORDER_SEARCH_ORACLE_PYTHON=/path/to/pinned/django-python \
  node node_modules/vitest/vitest.mjs run --config tools/order-search/vitest.config.ts
node node_modules/typescript/bin/tsc -p tools/order-search/backend.tsconfig.json
```

The frontend commands use `tests/order-search/vitest.config.ts`, `tests/order-search/tsconfig.json` and `tests/order-search/browser-check.mjs`; the retained browser check is `tests/order-history/browser-check.mjs`. Lint explicit owned files; fixture caches are ignored artifacts, not source.

An ST request with no selected stores and no explicit IDs is an input-level empty set, matching the original empty IN predicate. It returns `emptySelection:true` and the UI says “No stores selected”; it makes no warehouse-result/publication claim. Nonempty scopes, including scopes with zero matching data, still require complete manifests.

## W5 Phase D update (19 November 2026)

- Reads: primary reader for every date (legacy `AjaxOrderListView` uses the default database). The
  BigQuery index/facts publication path, HMAC contact keys and the in-memory reducer were removed.
- Windows: `placedFrom`/`placedTo` (legacy `__gte`/`__lte`), calendar `from`/`to`, or none (legacy Online
  page). The 62-day span and future-date refusals were removed; legacy has neither.
- Explicit order IDs reach any store, as legacy ("Allow to see all stores order if search by order id").
  N type: `user_type != 2 or order IDs`; otherwise an empty list, as legacy `Order.objects.none()`.
- Queue tabs (`in_queue`, `not_packed`): no row bound (the rewrite's 10 000 "safety bound" was removed).
- `order_store.first()` is used for store name/counter/flags for every viewer, as legacy.
- Page size: 1..100, the legacy DataTables `lengthMenu` (`order/templates/order/index.html:456`).
- Options add `hyperlocalTabs` (`_hl_get_tab_counts`, `order/views.py:4696`, READ_DB_ALIAS → data reader).

| Case | Legacy | Rewrite |
|---|---|---|
| Selected store outside the operator's stores | accepted | 403 `ORDER_SEARCH_SCOPE_DENIED` "This order selection is outside your current store permissions." |
| HL/queue search without check-in | `location_id=0` → empty list | 409 `ORDER_QUEUE_CHECK_IN_REQUIRED` "Check in to a store before opening its local-delivery queue." |
| No store selected (ST, no IDs) | client alert "Please select atleast one store" | `emptySelection: true`, UI shows the same text |
