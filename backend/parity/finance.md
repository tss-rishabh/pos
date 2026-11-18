# Finance migration evidence

Source baseline: `backend-pos-web` commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

The finance plugin currently implements twelve resource routes. Daily store sales is owned by the root reporting module and is not counted here.

| Source surface                                    | Rewrite                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Day Close page / current state                    | `GET /api/v1/stores/:storeId/day-closes[?date=...]`; `DayClosePage`                          |
| Explicit-date state                               | `GET .../day-closes/:date`                                                                   |
| Submit / revision / banking update                | `POST .../day-closes/:date/versions`                                                         |
| Date-specific revision history                    | `GET .../day-closes/:date/versions`                                                          |
| Evening/morning nag                               | `GET .../day-close-prompt`                                                                   |
| Lost-response reconciliation                      | `GET /api/v1/finance/day-close-commands/:commandId`                                          |
| Cash balance page / AJAX ledger / CSV data        | `GET /api/v1/reports/store-cash-balances`; `CashLedgerPage`                                  |
| Eligible cash-ledger stores                       | `GET /api/v1/reports/store-cash-balances/stores`                                             |
| Glassbox orders reconciliation feed               | `GET /api/v1/finance/reconciliation/orders`, service header `X-API-Key`                      |
| Cross-store day-close logs/search/latest attempts | `GET /api/v1/reports/day-close-history`; `DayCloseHistoryPage`                               |
| Complete filtered close-history CSV               | `GET /api/v1/reports/day-close-history/export`                                               |
| Scheduled pending-close alert                     | `POST /api/v1/webhooks/day-close-alerts`, service header `X-API-Key` using `REPORTS_API_KEY` |

Apply `src/modules/finance/migration.sql` after the shared legacy mapping, administration/check-in, and fulfillment outbox prerequisites. Only rewrite-owned close-command and alert-command idempotency tables are created. Legacy banking/day-close uniqueness and ID generation must match verified source metadata; the runner must never recreate legacy tables.

Offline cash was deleted (W7, 19 November 2026). Collection snapshots and the current ledger use the source cash sum (`order_stores.offline_payment`, `COUNT(*)` orders) plus the payment-correction adjustments only. The late-offline-cash ledger note is gone. Historical cash rollups must now acknowledge `BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT=pos-cash-collections-v2` and expose `offline_cash_projection_contract` with that value; the `late_offline_cash` column is no longer read, and the cash-ledger payment-correction baseline hash no longer includes it. See `w7-report.md`.

## Verified evidence

- Actual Python window/role/revision/stale-close policy functions are extracted and executed for 106 cases; monetary half-even behavior is compared for 40 cases.
- Actual Python ledger functions are executed for seven anchor/revision/banking/gap/stale-close cases. Ledger bounds retain the 366-day source rule and clamp future To dates.
- Isolated local MySQL verifies source collection predicates, duplicate return rows using EXISTS semantics, eight concurrent identical close attempts producing one close/banking record, expected-version conflicts, and stale marking after collection drift.
- Current-day anchored ledger reads use DATA only after proving no current returns in the same repeatable-read snapshot. Return cohorts and historical chains use the complete qualified warehouse generation. Tests reject missing warehouse mappings and prove no historical MySQL report fallback, including a nominally current report whose opening anchor is older.
- Browser command tests preserve stable idempotency IDs after uncertainty, reject changed figures, and persist only a SHA-256 digest and command metadata; monetary entries and comments are not persisted. Preview arithmetic uses integer cents.

Operational close checks always recompute against the writer, under SQL check-in/store locks, and never authorize a close using warehouse data. The client cannot submit a computed difference. Banking and close-version writes commit atomically. A close command ID cannot be reused with changed figures.

This is source-derived and fixture-tested evidence, not full route/UI/production-data parity certification. SSO provider details, live warehouse contracts, browser/desktop acceptance fixtures, and real reconciliation exports remain external acceptance requirements.

## Glassbox reconciliation feed

The active source feed type is `orders`. Its source envelope, mandatory `from`, `to`, `page`, `page_size` query fields, optional `store_code`, decimal JSON types, one-sale-per-order aggregation, per-line returns, refund split, lexical order-ID sorting, and pagination are retained. The route uses a constant-time service credential check before query parsing/DB access; a browser cookie cannot substitute for `GLASSBOX_FINANCE_FEED_API_KEY`.

`GLASSBOX_FINANCE_FEED_MAX_DATE_RANGE_DAYS` defaults to `1`; `GLASSBOX_FINANCE_FEED_MAX_PAGE_SIZE` defaults to `1000`, as in the source. Query outputs are bounded to 70,000 total input lines. Today's bounded sale cohort uses DATA through bound Drizzle SQL; its return component always uses BigQuery because joined sale/tax/refund facts may be older. Historical/mixed sale cohorts also use BigQuery. `feed-sql.ts` is generated from the inspected purpose-built source queries and records their SHA-256. Refund/return date predicates retain both selective UNION branches, including returns for sales outside the selected sale date.

The source uses non-grouped projections with `GROUP BY hp.id`. The rewrite explicitly wraps those projections in `ANY_VALUE` for MySQL's `ONLY_FULL_GROUP_BY`; `MAX` refund aggregation and business predicates remain unchanged. A local isolated fixture compares the actual source queries (on the fixture connection with that SQL-mode flag temporarily disabled) with the rewrite under strict mode. Real legacy orders with multiple conflicting active payment/store rows retain the source's arbitrary projection semantics and need data-specific acceptance fixtures; no deterministic choice or full-data equivalence is claimed for that ambiguous source case.

The source SQL references three columns omitted from its Django models: `has_products.hp_tss_points_used`, `has_products.store_disc_pg`, and `tss_money_history.has_product_id`, plus the external `refund_requests` table. Read-only live metadata confirms the three columns (FLOAT NOT NULL, FLOAT NULL, and BIGINT NULL respectively), and separately confirms the external refund table's order/product/HP IDs, approval/refund enums and event timestamps. No legacy DDL is applied by the rewrite. Source DATETIME ingestion timezone still needs environment-level confirmation.

Historical/mixed-day pulls require `BQ_FINANCE_RECONCILIATION_SALES` and `BQ_FINANCE_RECONCILIATION_RETURNS`, validated fully qualified compatible views. Queries carry resource label `finance-reconciliation`; no history fallback to MySQL exists. Each view must expose `line_item_id` for stable row ordering, `transaction_date` as the same business-local DATETIME, and exactly the source query aliases from `feedLineSchema`/`feedSaleLineSchema`. Common columns: `id,transaction_date,LocationCode,PaymentMode,PayAmount,PaymentStatus,OrderAmount,order_ref_no,counter_name,TaxRate,LineItemSubTotalWoTax,PayAmountRefunded,PayAmountRefundedMode`. Sale views additionally require `CASH,PaytmCardUpi,PinelabCardUpi,OnlineOther,DistrictAmount,TssMoneyUsed,CreditPincodeAmount,VoucherAmountUsed,CouponAmountUsed,TssPointsUsed,PgDisc`. Preserve the source DECIMAL columns as decimal strings (zero is normalized to numeric zero exactly as Python's `or 0`); floating source columns remain numeric. The return view must retain UNION ALL line granularity and its own return/refund event date, including the original taxable-value CASE branches. The copied source SQL is the business contract for building these views.

Evidence includes 20 actual-Python record-shaping oracle cases, a source-SQL/strict-mode isolated MySQL comparison, service-key bypass tests, and historical warehouse routing tests that perform zero MySQL report reads.

## Close history and pending alerts

Cross-store history preserves every attempt or latest-per-store/day filtering, literal case-insensitive status/reason/comment search, source ordering, tolerance-based TALLIED/SHORT/EXCESS labels, closed-late boundaries, and the complete 28-column financial export. Latest-attempt selection happens before search, so an older matching attempt never substitutes for a newer non-matching attempt. CSV cells guard spreadsheet formulas while preserving signed numeric monetary cells. An immediate authenticated CSV download remains available. The operational-reports plugin additionally implements the durable queue/private-storage/history lifecycle for day-close history and cash balances; see `report-exports.md` for its migration, worker options, permissions and exact evidence.

Current-day history uses the data reader; historical or mixed-day history uses `BQ_FINANCE_DAY_CLOSES` with full raw close columns required by `history.ts`, labeled `day-close-history`. Current store names and operator usernames are batched metadata reads from the primary reader, not historical financial fallback. Comments/search values/usernames are not logged. Ingress/access logs must also omit query strings because report search can contain sensitive free text.

The pending-alert service derives the last expired business day from the configured close cutoff. It refuses an active close window, checks enabled active stores against authoritative writer closes under store locks, and queues at most one effect set per immutable command ID. The application worker delivers those effects; route responses distinguish queued from delivered. `REPORTS_API_KEY` is required in `X-API-Key` and browser cookies cannot bypass it. Retry receipts remain tied to the original selected day. Local fixtures test concurrent duplicate commands, active-window rejection, filed closes, current rollout rules and request-ID propagation; actual Slack delivery has not been invoked by tests/tools.

## Cash ledger warehouse contract

Historical ledger queries carry the `cash-ledger` resource label and use the shared BigQuery billing/time/row guards. Configure these validated fully qualified table/view identifiers:

| Option                        | Required columns                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BQ_FINANCE_OPENING_BALANCES` | `store_id,balance_date DATE,amount NUMERIC`                                                                                                                 |
| `BQ_FINANCE_DAY_CLOSES`       | `store_id,close_date DATE,version,status,cash_system,cash_refund_system,cash_manual_punched,cash_manual_created,cash_actual,cash_difference,banking_amount` |
| `BQ_FINANCE_DAY_BANKING`      | `store_id,banking_date DATE,amount`                                                                                                                         |
| `BQ_FINANCE_CASH_COLLECTIONS` | `store_id,business_date DATE,cash,cash_refund`                                                                                                              |

Opening anchors must be unique by store/date; banking must be unique by store/date. Close versions use the largest version for each store/date. Monetary columns must retain exact decimal values. The collections view must contain at most one row per store/date, with the exact source cash collection and cash-refund predicates. Sparse days mean zero, not an unknown/unloaded partition; ingestion completeness must be validated before enabling the mapping.

The cash predicate is `SUM(order_stores.offline_payment)` for orders created within the business-local day, restricted to the store and with `offline_payment + online_payment + online_other_payment > 0`. There is no extra order-status exclusion. Cash refunds sum `amount_to_be_refunded_log.refunded_amt` where `refund_mode='cash'` and `is_refunded=1`, once for each matching log row that has at least one return row in that store/day with the same order and HP IDs. Duplicate return rows must not multiply the refund. The ledger uses cash minus cash refund for an unclosed day; closed days use their recorded snapshot/manual adjustments and the current banking override.

Current-day report reads are permitted on DATA only when every selected store has an anchor dated today and the same repeatable-read snapshot has no return rows for that current day. A bounded return-cohort discovery query switches to the complete qualified BigQuery ledger without reading older native refund amounts. A return appearing before the DATA snapshot fails with LEDGER_HISTORY_REQUIRED; refresh requires that current-day publication. A true empty return cohort skips the undated refund-log query entirely; immutable payment-return corrections remain separately included. Otherwise the complete chain is a warehouse report, even when the requested date is today. Store visibility metadata remains authoritative on the primary reader.

## Other implemented active report groups and acceptance limits

Combined order transactions are implemented and evidenced in `order-transactions.md`; flash sales in `flash-sales.md`; hyperlocal daily exports in `hyperlocal-daily.md`; the seven active scheduled hyperlocal/CRM groups in `scheduled-reports.md`. Their corresponding source page/AJAX/service routes are mapped in those manifests. Commented-out source routes are not counted as delivered features.

The cash-ledger UI now preserves the source ledger order, smart search and paging before adding optional exact-money sorting. Its filtered CSV includes every matching row across pages. Named full exports retain all selected store/date rows and are queued through the private export service. Search is local and never enters URLs/logs; financial chains are fully computed before display filtering. Three independent historical ledger reads run concurrently after opening anchors are resolved. Source exposes CSV exports; no original XLSX formatting feature is inferred.

Fixture/source-query evidence does not certify every original browser-template interaction, warehouse snapshot freshness, production-data grouping anomalies or live service delivery. These remain explicit release/acceptance requirements.

Cash-ledger display selection tests compare nine smart-search patterns with the actual shipped DataTables 1.10.23 search function, retain source row order by default, verify exact large/negative monetary sorting and preserve the original full-chain data. The original cash-balance template disabled sorting; the new sort control is an added display option. Chromium protocol fixtures verify 50-row paging, search, all-matching-row CSV and named full queue submission without live services. Evidence: `evidence/operational-reports/cash-ledger-controls.png` and `export-archive.json`.
