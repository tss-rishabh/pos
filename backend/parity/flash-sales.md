# Flash-sales source and query evidence

Source: `report/datatables/sales_data.py:AjaxSalesDataView`, baseline `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. the former `tools/operational-reports/generate-flash-sales-sql.py` (removed 19 November 2026; output frozen) extracted inspected SQL and the 22-column CSV manifest using AST only and records the source SHA-256. It does not import Django or connect to services.

`POST /api/v1/reports/flash-sales/search`, `FlashSalesPage({user,storeId})` and the queued `flash-sales` export cover the source screen, full export and financial buckets. Calendar dates select inclusive complete business days. Internal operators select stores explicitly; non-superadmins cannot cross assignments. Restricted user type 2 uses all its assigned stores, preserving the source override of a narrower selection, while an unassigned restricted account cannot request other stores. Jobs freeze those assignments and check writer-current role/type/assignment on subsequent artifact access.

Material source quirks are intentionally preserved and regression tested:

- The screen retains Paytm card/UPI LEFT JOIN multiplicity in line counts and district/credit sums. The source full-export SQL omits those two joins, so screen and file may differ for orders with multiple completed payment rows. Their separate queries remain separate.
- Order cash sums all order_store rows for an eligible order, including rows at other stores. Paytm totals include only selected-store transactions.
- Quantity sold is joined line-row count, not the sum of product quantity. Order-status exclusions remain 0, 1, 4 and 17; no new line-status exclusion is added.
- District/credit amounts are included in online-other and added again to total_sales by the source reducer. Online payment itself is displayed but not added to that total.
- Refunds retain source joins/multiplicity and order-store attribution, rather than return-store attribution. Ordinary positive refunds require return_mode=3; automated refunds require return_mode=2 and their own refunded timestamp. Refund-only dates without a source sale group remain absent.
- The source CSV header `district_transation_amt` maps the absent key `district_transaction_amt`. That file cell remains blank; the screen's district amount remains populated. Source export type `RETURN` was a metadata mislabel; new opaque queue kind is `flash-sales` without changing row calculations.

The bound Drizzle implementation replaces per-order cash/payment scalar queries with eligible-order CTE aggregates and a batched store join. It preserves joins that affect source multiplicity. Explicit ANY_VALUE permits strict MySQL grouping while retaining source ambiguous store labels/IDs. Refund reduction uses one indexed pass rather than repeated full-list scans. Rows are bounded at 70,000 before formatting; query errors are static and do not expose SQL or values. No production latency claim is made from synthetic fixtures. StoreName is source non-grouped data: production rows with several selected order_store owners need reconciliation because the original label itself depends on query plan.

Current-day sale cohorts use the data reader; their refund component uses BigQuery because return/refund dates do not bound original Order/HP/refund-log facts. Historical/mixed sale cohorts also use BigQuery. These eight explicit compatible relations are required, mapped to the corresponding verified source tables and column types:

| Option | Source relation |
|---|---|
| `BQ_FLASH_SALES_ORDERS_VIEW` | `orders` |
| `BQ_FLASH_SALES_ORDER_STORES_VIEW` | `order_stores` |
| `BQ_FLASH_SALES_LINES_VIEW` | `has_products` |
| `BQ_FLASH_SALES_STORES_VIEW` | `stores` |
| `BQ_FLASH_SALES_PAYTM_TRANSACTIONS_VIEW` | `pos_paytm_transactions` |
| `BQ_FLASH_SALES_RETURN_ORDERS_VIEW` | `return_orders` |
| `BQ_FLASH_SALES_REFUND_LOGS_VIEW` | `amount_to_be_refunded_log` |
| `BQ_FLASH_SALES_AUTOMATED_REFUNDS_VIEW` | `automated_refund_sic_logs` |

Each relation exposes the source column names referenced by `flash-sales-sql.ts`/`flash-sales-query.ts`, with lossless integer IDs, business-local DATETIME, source string/enum values, source nulls and FLOAT64 for the verified MySQL float/double money values. Join cardinality and duplicate rows must remain intact; snapshots cannot be pre-aggregated at a different grain. Queries bind store arrays and date parameters, use resource label `flash-sales`, preserve separate screen/export joins and never fall back to MySQL history. All eight mappings and warehouse timestamp/float reconciliation are deployment gates.

Evidence: forty fixtures run the actual Python reducer AST to compare binary round-to-two, ties-to-even net cash, refund buckets, nulls and totals. A guarded fresh local MySQL schema uses eight tables created from verified physical metadata, runs actual original screen/export/refund SQL in source grouping mode, then compares the strict optimized implementation. It covers multiple card/UPI rows, an out-of-scope cash/payment row, line counts versus quantity, status/date exclusions, duplicate return joins, ordinary/automated refunds, inclusive boundaries and page reset. Warehouse tests prove bound relations/parameters and missing-view failure. These are deterministic source-derived fixture checks; full production-data, original-template and live delivery certification remain open.
