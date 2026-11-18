# Daily store sales and offline cash

> **Changed 19 November 2026 (W7).** Offline cash was deleted. The current-day report now runs the source `report_queries.py` store/online SQL with only the payment-correction changes; `pending_offline_orders`/`pendingOrderCount` are gone and the warehouse contract is `pos-daily-store-sales-v2`. The offline-cash text below is historical; see `w7-report.md`.

Baseline: POS source `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`; `report/report_queries.py` SHA-256 `6ef32f5c50ca710f32aefeb5f0ecd92462e10a0687f78ad71da1d90e5220cd20`.

`GET /api/v1/reports/daily-store-sales` retains the source HP predicates, grouping/multiplicity, discounts, membership, online residual, all 31 original/additional established fields and weighted totals. The new `pending_offline_orders` column and `pendingOrderCount` response explain cash receipts whose source HP rows are not yet imported. Existing Python merge/rounding vectors remain unchanged when that optional field is absent.

Current-day excluded-product lookup, sales queries, immutable receipt totals, sealed import verification and banking use one read-only repeatable-read transaction on the data reader. The original source SQL changes only by adding a per-order verified-import flag and changing the outer cash/order-count expressions. Original `ord.cash` is retained for `total_online`; setting that intermediate cash to zero would invent online payments. Source HP quantity/revenue/status remains current and is not inferred from receipt payable amounts.

Every accepted/conflicted/importing/imported receipt contributes immutable payable cash and one logical order on its server-authorized `business_date`. An exact imported source order is excluded only from those cash/count expressions after trusted Ed25519 proof, original receipt hash, link binding and stable Order/OrderStore/HP ownership/quantity verification. It remains in the HP revenue/quantity query. A subsequently returned HP line can reduce source revenue/quantity while the receipt's cash remains recognized; cash refunds/outflows belong to the separate finance ledger. Pending-only store/date rows have zero imported HP revenue/quantity and an explicit pending count. Source-only arithmetic and current-day reader behavior have native differential coverage.

Store scope uses the shared current principal rules, including assignment scope for franchise role 1. The original role/checked-in-store rollout gate remains. API/store/date inputs are validated; IDs and SQL values bind through Drizzle. Request bodies, query values, rows and raw SQL/SDK errors do not enter logs. Frontend requests and CSV exports bind the captured operator. Existing column preferences remain user scoped; report rows are not persisted as an offline financial authority.

Historical/mixed ranges use BigQuery for the entire report. They cannot fall back to historical MySQL, even for an empty result. The configured rollup and publication relations are described in `tools/reports/daily-warehouse-contract.json`. The reader selects one complete immutable generation for every requested store/day, including explicit zero-row partitions, and requires:

- Exact source baseline/SQL hash, business timezone and `pos-daily-store-sales-offline-v1` projection contract.
- One shared publication time, CDC watermark and source position across the selected partition manifest.
- A recent publication and CDC watermark, with bounded future clock skew.
- Exact partition coverage, 0–2 unique source rows per day, native row hashes, and matching source identities/counts. Missing, partial, duplicate, stale, mixed, changed or unconfigured publications fail before returning report data.

Banking, footfall and target are in the same generation as its sales rows. The reader does not join newer auxiliary snapshots onto historical money. It computes row hashes in BigQuery using the exported `dailyWarehouseRowHashExpression`; the publisher must use that exact expression. It casts fields to strings before creating a fixed-order JSON STRUCT, then applies SHA-256 and lowercase hexadecimal encoding. See Google's [hash function](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/hash_functions#sha256) and [JSON serialization](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/json_functions#to_json_string) documentation. JavaScript never reconstructs a hash from converted floating-point values.

`BIGQUERY_DAILY_ROLLUP_TABLE` remains the rollup mapping. Module-owned validated options are `BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE`, `BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT`, `BIGQUERY_DAILY_REPORT_MAX_CDC_AGE_SECONDS` (300), `BIGQUERY_DAILY_REPORT_MAX_PUBLICATION_AGE_SECONDS` (900) and `BIGQUERY_DAILY_REPORT_MAX_CLOCK_SKEW_SECONDS` (30). The contract option must equal `pos-daily-store-sales-offline-v1`; table identifiers are fully qualified and validated. No real project, dataset, ETL writer or publication is fabricated or provisioned by these changes. Production configuration, immutable publication permissions, CDC completeness and actual warehouse/native differential proof remain release gates.

Evidence: `tests/parity.test.ts` executes the pinned Python merge and float-rounding oracles. `tests/finance/offline-cash.mysql.integration.test.ts` reuses fresh verified-schema/sealed-receipt fixtures for source SQL equality with no receipts, data-reader transaction selection, cash/order deduplication, pending counts and later HP returns. `tests/reports/` validates named query bindings, source/generation/content/clock/empty-result gates, SDK scalar decoding/budgets and sanitized errors without cloud calls. The isolated Chromium harness `frontend/tests/reports/browser-check.mjs` passes five workflows: captured actor/multi-store request, pending/freshness notices, all 32 columns, pagination/full totals and complete formula-safe CSV. Its screenshot and JSON are in `parity/evidence/reports/`. This is bounded implementation evidence, not a claim of deployed BigQuery parity.
# Daily report table controls — implementation follow-up

The pinned `report/templates/daily_store_report/index.html:228` uses a
client-loaded DataTable with search, sorting, column visibility, visible-column
CSV and page lengths 10/25/50/100/500. The React replacement already had column
visibility and a full-column/full-result CSV, but its fixed 50-row pages and
missing search/sort/selected-column export did not cover these source controls.

`frontend/src/pages/reports.tsx` now adds those controls over the already-loaded
bounded report result. Filtering/sorting is memoized, only the current page is
rendered, and no extra query or client-stored customer/report data is introduced.
Visible-column CSV follows table search/order; the existing complete CSV keeps
its original unfiltered data, columns and totals. Both retain the full server
totals rather than recalculating financial totals from a page or text search.
Column display labels and presentation remain intentionally redesigned.

The actual React component now passes seven isolated Chromium checks on Node
24.22.3: all 34 source/additive columns, correction values and full totals,
quoted search, sorting and page lengths without another report query,
all-matching selected-column CSV, formula protection, and byte-identical
complete CSV before/after local filtering. Saved evidence is
`parity/evidence/reports/browser.json`; HTTP/warehouse facts are synthetic.
The fixture runner is included in the consolidated `--browser` gate and uses
an owned temporary Vite cache with automatic server/cache cleanup.
This is not deployed source-workflow or original CSV-byte certification.
Source-browser qualification of smart-search, null/numeric sorting and original
multirow headings/totals remains in the validation phase.

