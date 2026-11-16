# Staff performance migration evidence

Source baseline: `backend-pos-web` commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, `report/datatables/performance_report.py`, and page classes in `report/views.py`.

`registerOperationalReports` registers `POST /api/v1/reports/salesperson-performance/search` and `POST /api/v1/reports/cashier-performance/search`. Both use strict timestamp/store/paging/sort inputs and resource trace metadata. Frontend exports `SalespersonPerformancePage({user,storeId})` and `CashierPerformancePage({user,storeId})` live in `frontend/src/pages/operational-reports/performance.tsx`; shared report controls live in `report-view.tsx`. No migration is required. The module's read-only `PerformanceOrderStore` projection includes source unmanaged `salesperson_id` and `admin_user_id`, both confirmed INT NOT NULL in saved live metadata.

Both source HTML pages permit role 1. Their AJAX handlers omit that role guard; the rewrite enforces the page permission at the API. Restricted user type 2 must select assigned stores, including if its role is 1. This closes direct-AJAX/scope bypasses without broadening report access. Filters and staff/customer names are never logged.

## Source calculations

Salesperson sales sum `has_products.price` for DELIVERED lines, without multiplying quantity. Line-level salesperson wins unless zero, which falls back to the order-store salesperson. Empty employee IDs are excluded. The filter date is **line creation**, independently of order creation. Grouping remains by employee ID across selected stores. Rating is Python ties-to-even `round(total_sales * 100 / maximum_sales) / 10`, with zero maximum yielding zero. Rating sorting follows total sales, as the source does.

Cashier rows select nonempty order-store performance JSON and sum every joined line quantity, including cancelled lines. The filter date is **order creation**. The source groups by order before aggregating by cashier; its timing JSON contains string milliseconds. Active time subtracts payment/cart/behaviour durations from overall duration. Missing overall timing (`NaN`) is estimated from the average observed per-product time across orders, then weighted by each cashier's missing quantities. Source score normalization, zero-product behavior, negative durations, Python integer rounding, numeric-ID sorting and formatted timedelta output are retained. A displayed rounded second may be 60 without carrying into the minute, matching the source formatter. Malformed timing JSON/values fail with a static error, without exposing their contents.

Both source SQL queries select non-grouped fields. The rewrite explicitly uses ANY_VALUE for those fields so queries run with ONLY_FULL_GROUP_BY, preserving the source's arbitrary projection semantics. A real employee spanning stores can have an arbitrary displayed store; an order with conflicting order-store cashier/timing records can have an arbitrary representative record while quantities retain source join multiplicity. No deterministic business choice or full-data equivalence is claimed for those source ambiguities. Stable identity tiebreakers and bounded pagination improve predictable navigation.

The complete reducer requires the selected order/group set to calculate global scores, so queries aggregate in SQL, fetch at most 70,001 intermediate rows, and reject more than 70,000. There are no per-staff or per-order database loops. Explicit ranges follow the shared 62-calendar-day report bound; out-of-range pages reset to page one.

## Readers and warehouse contracts

The full selected current-business-day report uses the data reader. Historical/mixed ranges use named bound BigQuery queries and configured compatible views, with no MySQL history fallback. Both view identifiers are validated fully qualified `project.dataset.view` values. BigQuery ingestion must preserve source multiplicity, nulls, numeric values and business-local DATETIME semantics before release.

| Option / resource label | Required view rows and columns |
|---|---|
| `BQ_SALESPERSON_PERFORMANCE_VIEW` / `salesperson-performance` | One source joined delivered line/order-store row after effective-salesperson resolution and nonempty employee selection: `employee_id,store_id,store_name,salesperson_name,price,line_created_at DATETIME` |
| `BQ_CASHIER_PERFORMANCE_VIEW` / `cashier-performance` | Source order/order-store/user/line LEFT JOIN rows: `order_id,store_id,cashier_id,cashier_name,performance_json,line_qty,order_created_at DATETIME`. Retain no-line null quantity and repeated store/line rows. |

Scope and timestamp filters apply before employee/order grouping. Cashier performance JSON is at most the source VARCHAR(255) size. IDs must remain lossless. Price is the source floating column; acceptance must account for source floating aggregation and warehouse reduction behavior. View name/timestamp configuration is still a deployment input, not a guessed production mapping.

## Evidence and limits

Eighty cashier and seven salesperson fixture cases execute the actual Python reducer AST, covering missing-timing estimates, different quantities, zero totals, negative durations, ties, sorting and timedelta formatting. Isolated MySQL executes the actual source SELECTs on the same fixture and compares rewrite rows, including fallback/line salesperson, excluded empty employees, line/order date differences, cancelled-line quantity, store scope and strict-grouping compatibility. Only the fixture oracle connection temporarily relaxes ONLY_FULL_GROUP_BY for the original SQL, then restores it; rewrite queries remain strict-compatible. Warehouse tests prove bound source-specific dates/scopes/resource labels and no historical MySQL fallback. HTTP tests deny lower roles before DB access.

This establishes source-derived calculation/query evidence. Real conflicting grouped records, warehouse view snapshots, source collation sorting, browser/desktop interaction and full production-data parity still need acceptance fixtures; implementation routes are not parity certification.
