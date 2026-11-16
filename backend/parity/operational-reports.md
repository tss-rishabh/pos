# Operational report migration evidence

Source baseline: `backend-pos-web` commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

`registerOperationalReports(app,config,db)` implements eighteen resource routes covering feedback, inventory association repair, hyperlocal acceptance, staff performance, returned orders, combined order transactions and report export jobs/history/downloads. Apply `src/modules/operational-reports/migration.sql` to create the rewrite-owned export queue; it never recreates or alters legacy tables. All SQL writes in tests are confined to fresh, randomly named local fixture databases that are dropped after the tests.

| Source                                                   | Resource API                                                             | Frontend                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `report/datatables/nps_datatable.py:AjaxNpsDataListView` | `POST /api/v1/reports/customer-feedback/search`                          | `CustomerFeedbackPage({user,storeId})`       |
| `report/views.py:AjaxTroubleshootInventoryView`          | `POST /api/v1/stores/:storeId/inventory/parent-associations`             | `InventoryAssociationsPage({user,storeId})`  |
| Report export creation / `ReportExport`                  | `POST /api/v1/report-exports`                                            | `ReportExportsPage({user,storeId})`          |
| Report export page / AJAX history                        | `GET /api/v1/report-exports?origin=current` or `legacy`                  | Export history and pagination                |
| Private export-history filters / archive                 | `POST /api/v1/report-exports/search`                                     | Recent, pending and archived export history  |
| Hyperlocal acceptance page / AJAX                        | `POST /api/v1/reports/hyperlocal-acceptance/search`                      | `HyperlocalAcceptancePage({user,storeId})`   |
| Salesperson performance page / AJAX                      | `POST /api/v1/reports/salesperson-performance/search`                    | `SalespersonPerformancePage({user,storeId})` |
| Cashier performance page / AJAX                          | `POST /api/v1/reports/cashier-performance/search`                        | `CashierPerformancePage({user,storeId})`     |
| Return report page / AJAX                                | `POST /api/v1/reports/returned-orders/search`                            | `ReturnedOrdersPage({user,storeId})`         |
| Store/online sales and returns report                    | `POST /api/v1/reports/order-transactions/search`                         | `OrderTransactionsPage({user,storeId})`      |
| Hyperlocal daily page/export                             | `POST /api/v1/reports/hyperlocal-daily/search`                           | `HyperlocalDailyPage({user,storeId})`        |
| Flash sales page / AJAX / export                         | `POST /api/v1/reports/flash-sales/search`                                | `FlashSalesPage({user,storeId})`             |
| Seven scheduled hyperlocal/CRM groups                    | `POST /api/v1/report-deliveries`                                         | Header-authenticated scheduler               |
| Scheduled receipt                                        | `GET /api/v1/report-deliveries/:jobId`                                   | Delivery status                              |
| Uncertain destination reconciliation                     | `POST /api/v1/report-deliveries/:jobId/targets/:targetId/reconciliation` | Header-authenticated service                 |
| Durable receipt                                          | `GET /api/v1/report-exports/:exportId`                                   | Status recovery                              |
| Private completed file                                   | `GET /api/v1/report-exports/:exportId/file`                              | Authenticated CSV download                   |
| Protected legacy file                                    | `GET /api/v1/report-exports/legacy/:exportId/file`                       | Authenticated legacy CSV download            |

Frontend exports live in `frontend/src/pages/operational-reports/{feedback,inventory,exports,acceptance,performance,returned-orders,order-transactions,hyperlocal-daily,flash-sales}.tsx`.

## Customer feedback

All authenticated roles may search their permitted stores. Internal role 1/user type 1 may include all stores and online orders. Restricted `userType=2` operators must select an assigned franchise store, and customer name/email/telephone values are masked on the server using source-derived helpers. Masking handles Unicode name code points, international digit strings, malformed contacts, and missing joined users. Nullable questions and feedback dates remain null and render placeholders instead of crashing.

Filters include a business-local order timestamp range (inclusive To time), selected store/order IDs, exact email, page and page size. Query values are bound with Drizzle; source string interpolation of email/store values is not retained. Sensitive filters are posted in a body and are never logged. Store scope is checked before report execution, with stricter assigned-store enforcement for non-superadmin internal operators than the source's user-type-only restriction.

Current business-day reports use the data reader. Historical/mixed-day facts use the verified raw BigQuery feedback/orders/order_stores tables by default, labeled `customer-feedback`, with no historical MySQL fact fallback. Missing BigQuery questions do not block this path: the source uses a current dimension lookup, implemented as one bounded primary batch after paging. Customer/store display dimensions likewise remain current. Exact native MySQL email equality supplies a bounded ID filter, retaining source accent/case/PAD SPACE behavior without LOWER-based warehouse comparisons.

The optional `BQ_CUSTOMER_FEEDBACK_VIEW` now has a facts-only contract:

`feedback_id,store_row_id,order_id,customer_id,store_id,question_id,feedback,feedback_date,order_date`

It preserves every feedback × store row, including duplicate same-store and null online associations. IDs remain lossless, question IDs are nullable, and dates remain business-local DATETIME. Contact/question text views require revision to this explicit contract. Writer-current role/type/store authority is checked around external work, and returned fact scope is validated before reading contacts. Over-wide current dimensions fail explicitly rather than truncating matches. The actual raw dry-run estimate is 577,884,239 bytes, within the unchanged 1 GB cap; runtime estimates and server byte/time guards remain enforced.

Read-only live metadata confirms the external NPS tables. The owned Drizzle mappings are read-only and never migrated. `nps_feedback.question_id` and `nps_questions.id` are INT; order IDs are BIGINT; feedback is VARCHAR(255); questions and feedback timestamps may be null.

Evidence: 25 fixture cases execute the actual Python privacy helpers. The current-dimension history extension has 15 native and 8 service checks, plus 10 actual BigQuery generated-literal cases; native primary/authority schemas contain no historical fact tables. Source SQL/current dimension output, join multiplicity, current edits/inactive/null questions, native email collation, 501-match failure, source paging and assignment revocation are verified separately. Existing current-day/HTTP checks retain scope, masking and input validation. No live customer data was read by these tests. Exact evidence, revised options, bounds and remaining CDC/deployment limits are in `feedback-history.md`; the database/query proposal is `feedback-history-query-proposals.md`.

## Inventory parent associations

Menu/server roles are 1–4. The API validates the signed-in operator header, checks requested store scope, then calls administration's `assertCurrentStoreAccess` inside the writer transaction. Shared locks prevent role/assignment revocation during the mutation; the target Store row serializes the repair with other store operations.

The anti-join preserves the source selection: a parent Product exists; at least one `prod_type=1` child has any product_store row at the selected store; that parent has no product_store row there. Child stock, availability, and deletion flags do not add new exclusions. A missing parent association is inserted with stock `0`, availability `true`, deletion `false`. Existing parent quantities/flags remain untouched. The verified `uq_product_store(product_id,store_id)` key and no-op conflict update prevent duplicates.

Cursor/limit batches preserve the complete repair without an unbounded request. The frontend advances batches until complete and requires an online service. This operation repairs associations and is separate from the verification-gated inventory stock procedure; it sends no external sync/message by itself, matching the source.

Evidence: the actual source SELECT is extracted and run on the same isolated MySQL fixture, then compared with the selected parent set. Tests cover duplicate variants, child flags, preserving existing parent stock/flags, cursor batches, replay, source-role/store boundaries, current writer assignment revocation, and concurrent repairs. These are fixture/source-query tests, not a claim of full production-data parity or every browser-template transition.

## Hyperlocal acceptance

`HyperlocalOrderAcceptReport` permits role 1 on the source page. The source AJAX endpoint lacks that role guard; the new API enforces it consistently, closing a direct-AJAX bypass. Restricted user type 2 requires selected assigned stores, including when its role is 1. Store scope and a strict sort allowlist are validated before database work.

The report retains every accepted hyperlocal_order_log row, current order location/store, staff full name (or numeric zero when missing), inclusive log-created timestamp bounds, and source minute-format dates. It uses the original MySQL TIMESTAMPDIFF/CONCAT duration expression, including day prefixes, seconds and negative-duration behavior. Duration sorting remains lexical, as in the source alias. Equal sort keys use a log-ID tiebreaker for stable pagination. Out-of-range pages return page one, as the source Paginator does. Staff resolution is batched once from current primary metadata instead of source per-row queries.

Today's report uses the data reader. Historical/mixed ranges require `BQ_HYPERLOCAL_ACCEPTANCE_VIEW`, a validated fully qualified compatible view containing `log_id,order_id,pos_admin_id,store_id,store_name,created_at,time_taken`. It must contain the source accepted-action selection, preserve all log rows and LEFT JOIN order/store nulls, and expose source duration strings. `created_at` is business-local DATETIME. Warehouse queries bind date/store/paging parameters and carry resource label `hyperlocal-acceptance`; no historical MySQL report fallback exists. Date ranges are explicit and bounded by the shared 62-calendar-day report policy.

Evidence: the actual source SELECT is extracted and run against the same isolated local fixture (Python adapter percent escaping is normalized), verifying inclusive midnight/To bounds, repeated logs for one order, declined exclusion, day/negative durations, store selection, staff names/missing users and page reset. Warehouse tests verify declared-view routing, bound scope, resource labels and missing-configuration failure. HTTP tests reject non-superadmin access before DB work. Full production-data and original-template browser parity remain acceptance requirements.

Staff calculation/query evidence and warehouse contracts are detailed in `staff-performance.md`. Durable export lifecycle/configuration is detailed in `report-exports.md`.

Return report source-query evidence, scope and warehouse contracts are detailed in `returned-orders.md`.

Combined order transaction calculations, all 75 source CSV columns and four warehouse contracts are detailed in `order-transactions.md`. Export metadata reader policy and compatible views are detailed in `export-history.md`.

Hyperlocal expiry-based daily report selection, lifecycle optimization, 17-column CSV and warehouse contract are detailed in `hyperlocal-daily.md`.

Flash-sales screen/export differences, financial buckets, optimized source queries and eight compatible warehouse relations are detailed in `flash-sales.md`.

Seven active scheduled hyperlocal/CRM groups, writer-current CRM refresh, service authorization and durable destination delivery are detailed in `scheduled-reports.md`. Apply its separate `scheduled-migration.sql` in addition to the export queue migration.
