# Exact source-surface implementation map

Baseline `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. **396 surfaces mapped; zero unmapped; zero release certifications added.**

This is the implementation inventory requested for the full rewrite, not a replacement for `release-coverage.json`. Existing component/source/native/browser tests remain bounded evidence. No original-template or complete production workflow is certified by this file.

| Source kind | Count |
| --- | ---: |
| routes | 255 |
| jobs | 32 |
| templates | 106 |
| websockets | 1 |
| administration | 2 |

The 263 route declarations contain eight include mounts; all 255 leaves remain individually mapped, including aliases/duplicates and the framework-admin mount. Order routes retain both `/api/v1/orders/` and `/orders/` mount paths. All 32 named tasks and all 106 templates remain visible, including latent/commented callers and diagnostics.

## Concrete remaining code, by feature group

No additional missing source-feature implementation is currently identified by this map. The named external acceptance gates, default-disabled selections and explicit inactive/diagnostic exclusions remain. Known defects and inactive policy candidates retain their separate decision records; the wallet calendar-date decision in `compatibility/upstream/other-writer-origins/go/expiry-review/parity-decision.md` remains pending. No release, default-gate or full-workflow certification is added.

## Line-bound implementation review

These reviewed code paths bind actual import/manager/table controls and preserve the explicitly excluded source diagnostics/prototype and inactive upload-log/download. Line anchors are regenerated from current implementation or pinned source; test presence does not establish these claims.

### stores

Mapped surfaces: `stores/urls.py:8` (implementation_present), `stores/urls.py:9` (implementation_present), `stores/urls.py:10` (implementation_present), `stores/urls.py:11` (external_acceptance), `stores/urls.py:13` (implementation_present), `stores/urls.py:14` (external_acceptance), `stores/urls.py:15` (implementation_present), `stores/urls.py:16` (implementation_present), `stores/templates/stores/_form.html` (external_acceptance), `stores/templates/stores/create.html` (external_acceptance), `stores/templates/stores/edit.html` (external_acceptance), `stores/templates/stores/index.html` (external_acceptance), `stores/templates/stores/show.html` (external_acceptance), `stores/admin.py:6` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/administration/stores.tsx:179` | Actual active/archived collection page selects its source-specific paged/sorted view and common visible-column/page-CSV controls. |
| `frontend/src/pages/administration/collection-table.tsx:81` | Shared control renders source page-size/sort/column choices and loaded-page CSV; full current collection export uses the existing protected queue. |
| `backend/src/modules/administration/collection-export.ts:170` | Actual source-authorized renderer uses finite resource/column/sort input, bounded primary current rows and the existing queue artifact lifecycle. |
| `backend/src/modules/administration/store-detail-routes.ts:14` | Actual selected-store detail/PNG endpoints recheck current native scope and encode only the exact static public marketing URL, not a login/application capability. |
| `frontend/src/pages/administration/stores.tsx:444` | Actual store row opens its selected-store detail/marketing QR action; checked-in application handoff remains separate. |

### storage

Mapped surfaces: `stores/urls.py:21` (implementation_present), `stores/urls.py:22` (implementation_present), `stores/urls.py:23` (implementation_present), `stores/urls.py:24` (implementation_present), `stores/urls.py:25` (implementation_present), `stores/urls.py:26` (implementation_present), `stores/urls.py:27` (implementation_present), `stores/urls.py:28` (implementation_present), `stores/templates/stores/storage/create.html` (implementation_present), `stores/templates/stores/storage/edit.html` (implementation_present), `stores/templates/stores/storage/index.html` (implementation_present), `stores/templates/stores/storage/show.html` (implementation_present).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/administration/store-resources.tsx:28` | Actual active/archived collection page selects its source-specific paged/sorted view and common visible-column/page-CSV controls. |
| `frontend/src/pages/administration/collection-table.tsx:81` | Shared control renders source page-size/sort/column choices and loaded-page CSV; full current collection export uses the existing protected queue. |
| `backend/src/modules/administration/collection-export.ts:170` | Actual source-authorized renderer uses finite resource/column/sort input, bounded primary current rows and the existing queue artifact lifecycle. |

### counters

Mapped surfaces: `stores/urls.py:31` (implementation_present), `stores/urls.py:32` (implementation_present), `stores/urls.py:33` (implementation_present), `stores/urls.py:34` (implementation_present), `stores/urls.py:35` (implementation_present), `stores/urls.py:36` (implementation_present), `stores/templates/counters/index.html` (implementation_present).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/administration/store-resources.tsx:28` | Actual active/archived collection page selects its source-specific paged/sorted view and common visible-column/page-CSV controls. |
| `frontend/src/pages/administration/collection-table.tsx:81` | Shared control renders source page-size/sort/column choices and loaded-page CSV; full current collection export uses the existing protected queue. |
| `backend/src/modules/administration/collection-export.ts:170` | Actual source-authorized renderer uses finite resource/column/sort input, bounded primary current rows and the existing queue artifact lifecycle. |

### salespeople

Mapped surfaces: `core/urls.py:53` (implementation_present), `core/urls.py:54` (implementation_present), `core/urls.py:55` (implementation_present), `core/urls.py:56` (implementation_present), `core/urls.py:57` (implementation_present), `core/urls.py:58` (implementation_present), `core/urls.py:59` (implementation_present), `core/urls.py:60` (implementation_present), `core/templates/salespersons/_form.html` (implementation_present), `core/templates/salespersons/create.html` (implementation_present), `core/templates/salespersons/edit.html` (implementation_present), `core/templates/salespersons/index.html` (implementation_present).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/administration/people.tsx:372` | Actual active/archived collection page selects its source-specific paged/sorted view and common visible-column/page-CSV controls. |
| `frontend/src/pages/administration/collection-table.tsx:81` | Shared control renders source page-size/sort/column choices and loaded-page CSV; full current collection export uses the existing protected queue. |
| `backend/src/modules/administration/collection-export.ts:170` | Actual source-authorized renderer uses finite resource/column/sort input, bounded primary current rows and the existing queue artifact lifecycle. |

### operators

Mapped surfaces: `users/urls.py:14` (implementation_present), `users/urls.py:15` (implementation_present), `users/urls.py:16` (implementation_present), `users/urls.py:17` (implementation_present), `users/urls.py:18` (implementation_present), `users/urls.py:19` (implementation_present), `users/urls.py:20` (implementation_present), `users/urls.py:21` (implementation_present), `users/templates/auth/create.html` (implementation_present), `users/templates/auth/edit.html` (implementation_present), `users/templates/auth/index.html` (implementation_present), `users/admin.py:20` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/administration/people.tsx:92` | Actual active/archived collection page selects its source-specific paged/sorted view and common visible-column/page-CSV controls. |
| `frontend/src/pages/administration/collection-table.tsx:81` | Shared control renders source page-size/sort/column choices and loaded-page CSV; full current collection export uses the existing protected queue. |
| `backend/src/modules/administration/collection-export.ts:170` | Actual source-authorized renderer uses finite resource/column/sort input, bounded primary current rows and the existing queue artifact lifecycle. |

### terminals

Mapped surfaces: `core/urls.py:131` (implementation_present), `core/urls.py:132` (implementation_present), `core/urls.py:135` (implementation_present), `core/urls.py:136` (implementation_present), `core/urls.py:137` (implementation_present), `core/urls.py:140` (implementation_present), `core/urls.py:141` (implementation_present), `core/urls.py:144` (implementation_present), `core/urls.py:145` (implementation_present), `core/templates/edc_edit/edc_detail_and_edit.html` (implementation_present).

| Code/source reference | Reviewed scope |
| --- | --- |
| `backend/src/modules/administration/index.ts:113` | Actual administration registrar mounts the credential-free EDC directory. |
| `backend/src/modules/administration/terminal-directory.ts:27` | Pine/Paytm union applies fresh role/current assigned-store authority, finite provider/search/sort and bounded primary paging; credential fields are not selected. |
| `frontend/src/pages/administration/terminal-directory.tsx:58` | Actual provider directory offers nonsecret columns, visibility/page choices and page/full CSV while preserving the independent write-only editor. |

### documentation

Mapped surfaces: `core/urls.py:123` (external_acceptance), `core/urls.py:124` (external_acceptance), `core/urls.py:125` (external_acceptance), `core/urls.py:126` (external_acceptance), `core/urls.py:127` (external_acceptance), `core/urls.py:129` (external_acceptance), `core/templates/documentation/_detail.html` (external_acceptance), `core/templates/documentation/_form.html` (external_acceptance), `core/templates/documentation/create.html` (external_acceptance), `core/templates/documentation/documentation_lists.html` (external_acceptance), `core/templates/documentation/index.html` (external_acceptance), `core/templates/documentation/show.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/administration/documentation.tsx:119` | Actual active/archived collection page selects its source-specific paged/sorted view and common visible-column/page-CSV controls. |
| `frontend/src/pages/administration/collection-table.tsx:81` | Shared control renders source page-size/sort/column choices and loaded-page CSV; full current collection export uses the existing protected queue. |
| `backend/src/modules/administration/collection-export.ts:170` | Actual source-authorized renderer uses finite resource/column/sort input, bounded primary current rows and the existing queue artifact lifecycle. |

### orders-read

Mapped surfaces: `order/urls.py:8` (external_acceptance), `order/urls.py:9` (external_acceptance), `order/urls.py:10` (external_acceptance), `order/urls.py:11` (external_acceptance), `order/urls.py:12` (external_acceptance), `order/templates/order/index.html` (external_acceptance), `order/templates/order/online/_return_exchange_cells.html` (external_acceptance), `order/templates/order/online/show.html` (external_acceptance), `order/templates/order/show.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/operations.tsx:279` | Actual OrdersPage mounts the source-specific search/list alongside independently authorized detail/payment controls. |
| `frontend/src/pages/order-history/SourceOrderList.tsx:180` | Actual order-list CSV uses only the loaded page and selected visible columns; page choices 5/10/25/50/100 and source sort actions remain wired. |
| `frontend/src/pages/order-history/search-client.ts:120` | Loaded duplicate rows are preserved and spreadsheet formula strings neutralized; this does not certify original full-workflow or identical download bytes. |

### checkout-cart

Mapped surfaces: `order/urls.py:22` (external_acceptance), `order/urls.py:23` (external_acceptance), `order/urls.py:24` (external_acceptance), `order/urls.py:25` (external_acceptance), `order/urls.py:26` (external_acceptance), `order/urls.py:27` (external_acceptance), `order/urls.py:28` (external_acceptance), `order/urls.py:29` (external_acceptance), `order/urls.py:30` (external_acceptance), `order/urls.py:31` (external_acceptance), `order/urls.py:32` (external_acceptance), `order/urls.py:35` (external_acceptance), `order/urls.py:36` (external_acceptance), `order/urls.py:38` (external_acceptance), `order/urls.py:39` (external_acceptance), `order/templates/order/create_order.html` (external_acceptance), `order/templates/order/tab.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `backend/src/modules/checkout/cancellations/membership-fence.ts:94` | Actual shared membership fence consumes authenticated fixed-function revision metadata under application authority without TRIGGER privileges, retaining exact bodies, native indexes/collations and revision semantics. Go/Python counterparts and independent-account workflow fixtures are integrated; this is not deployed or full-project certification. |

### pending-order-cancellation

Mapped surfaces: `order/urls.py:37` (external_acceptance), `order/templates/order/index.html` (external_acceptance), `order/templates/order/show.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `backend/src/modules/checkout/cancellations/membership-fence.ts:94` | Actual shared membership fence consumes authenticated fixed-function revision metadata under application authority without TRIGGER privileges, retaining exact bodies, native indexes/collations and revision semantics. Go/Python counterparts and independent-account workflow fixtures are integrated; this is not deployed or full-project certification. |

### returns-exchanges

Mapped surfaces: `order/urls.py:16` (external_acceptance), `order/urls.py:17` (external_acceptance), `order/urls.py:18` (external_acceptance), `order/urls.py:19` (external_acceptance), `order/urls.py:20` (external_acceptance), `order/urls.py:21` (external_acceptance), `order/urls.py:43` (external_acceptance), `order/templates/order/_exchange_js.html` (external_acceptance), `order/templates/order/index.html` (external_acceptance), `order/templates/order/online/_return_exchange_cells.html` (external_acceptance), `order/templates/order/online/show.html` (external_acceptance), `order/templates/order/show.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `order/views.py:4449` | Active source exact order/product/HP create/update, native administrator provenance, end-of-day date and reactivation; empty date is not a clear operation. |
| `order/templates/order/show.html:247` | Active source closed-window Extend Date action belongs to roles1-3; the manager action is separate from role1 cash/eligibility override. |
| `backend/src/modules/checkout/return-workflow/extensions.ts:19` | Actual native GET/PUT resource locks the exact tuple, preserves creation provenance, validates business dates and uses desired-state idempotency plus revision conflicts. |
| `backend/src/modules/checkout/return-workflow/repository.ts:619` | Extension uses current native manager/store/check-in authority, exact delivered HP, live customer/contact/OTP proof and unambiguous mapped audit actor inside the writer transaction. |
| `backend/src/modules/checkout/return-workflow/routes.ts:77` | Actual registered return registrar constructs and mounts the extension service; it is not an unused constructor. |
| `frontend/src/pages/returns/index.tsx:566` | Actual return and exchange page mounts the bound source-role manager control for the selected verified line. |
| `frontend/src/pages/returns/client.ts:243` | Client binds PUT and returned state to the exact order/line/product and current operator; it sends no refund or guessed manager fields. |
| `frontend/src/pages/returns/ReturnWindowExtension.tsx:48` | Unknown/conflicting save uses explicit GET-only recorded-date recovery and renewed attestation; Cancel clears local form state only. |

### express-fulfillment

Mapped surfaces: `order/urls.py:93` (external_acceptance), `order/urls.py:96` (external_acceptance), `order/urls.py:97` (external_acceptance), `order/urls.py:98` (external_acceptance), `order/urls.py:99` (external_acceptance), `order/urls.py:100` (external_acceptance), `order/urls.py:101` (external_acceptance), `order/urls.py:102` (external_acceptance), `order/urls.py:103` (external_acceptance), `order/urls.py:104` (external_acceptance), `order/urls.py:105` (external_acceptance), `order/urls.py:107` (external_acceptance), `order/urls.py:110` (external_acceptance), `order/urls.py:111` (external_acceptance), `order/urls.py:112` (external_acceptance), `order/urls.py:113` (external_acceptance), `order/tasks.py:150` (external_acceptance), `order/templates/order/_hl_banner.html` (external_acceptance), `order/templates/order/hyperlocal/_all_stores_order_cards.html` (external_acceptance), `order/templates/order/hyperlocal/_hl_eli_status_badge.html` (external_acceptance), `order/templates/order/hyperlocal/_hl_image_preview.html` (external_acceptance), `order/templates/order/hyperlocal/_hl_line_items_table.html` (external_acceptance), `order/templates/order/hyperlocal/_order_cards.html` (external_acceptance), `order/templates/order/hyperlocal/_progress_content.html` (external_acceptance), `order/templates/order/hyperlocal/all_stores_dashboard.html` (external_acceptance), `order/templates/order/hyperlocal/progress.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/fulfillment/global-expiry-alerts.tsx:53` | Global selected-store/current-check-in eligibility, grouped reminders and status banner are implemented; behavior still needs joined source/native/browser verification. |
| `frontend/src/pages/fulfillment/expiry-alerts.ts:31` | Shared scoped cache with one background poll owner, authority-denial masking and bounded server interval. This is implementation evidence, not a runtime certification. |

### notifications

Mapped surfaces: `notification/urls.py:7` (external_acceptance), `order/templates/order/_hl_banner.html` (external_acceptance), `notification/routing.py:6` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/fulfillment/notification-links.ts:29` | Retains source stored-title routing and explicit live new-order flag; derives bound order/queue links without trusting a stored URL. Joined notification/provider acceptance remains unproven. |

### finance-day-close

Mapped surfaces: `report/urls.py:16` (external_acceptance), `report/urls.py:73` (external_acceptance), `report/urls.py:74` (external_acceptance), `report/urls.py:75` (external_acceptance), `report/urls.py:76` (external_acceptance), `report/urls.py:77` (external_acceptance), `report/urls.py:78` (external_acceptance), `report/urls.py:79` (external_acceptance), `report/urls.py:80` (external_acceptance), `report/urls.py:81` (external_acceptance), `report/datatables/cash_balance_datatable.py:83` (external_acceptance), `report/datatables/day_close_datatable.py:216` (external_acceptance), `report/templates/day_close/cash_balance.html` (external_acceptance), `report/templates/day_close/index.html` (external_acceptance), `report/templates/day_close/logs.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/finance/day-close-reminder.tsx:43` | Global server-decided reminder with foreground-only reads, scoped snooze and correct-date navigation; no client financial calculation or policy change. Behavioral/source acceptance remains pending. |
| `frontend/src/pages/finance/ledger.tsx:33` | Actual cash-balance screen restores original default 31 and 31/62/100/500 page choices after complete-chain financial calculations. |
| `frontend/src/pages/finance/history.tsx:148` | Actual close-history loaded-page CSV is separate from its retained complete filtered CSV; it uses only the current authenticated bounded page. |

### daily-store-report

Mapped surfaces: `report/urls.py:69` (external_acceptance), `report/urls.py:70` (external_acceptance), `report/templates/daily_store_report/index.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/reports.tsx:181` | Actual DSR client table filters/sorts/pages loaded rows; server-calculated totals remain authoritative. |
| `frontend/src/pages/reports.tsx:191` | Actual visible-column CSV is distinct from the retained complete CSV and preserves the original server totals rather than recalculating financial amounts. |

### operational-reports

Mapped surfaces: `report/urls.py:19` (external_acceptance), `report/urls.py:20` (external_acceptance), `report/urls.py:21` (external_acceptance), `report/urls.py:22` (external_acceptance), `report/urls.py:31` (external_acceptance), `report/urls.py:36` (external_acceptance), `report/urls.py:37` (external_acceptance), `report/urls.py:51` (external_acceptance), `report/urls.py:52` (external_acceptance), `report/urls.py:53` (external_acceptance), `report/urls.py:54` (external_acceptance), `report/urls.py:65` (external_acceptance), `report/urls.py:66` (external_acceptance), `report/urls.py:87` (external_acceptance), `report/urls.py:88` (external_acceptance), `report/datatables/hyperlocal_daily_datatable.py:40` (external_acceptance), `report/datatables/return_orders_datatable.py:63` (external_acceptance), `report/datatables/return_orders_datatable.py:328` (external_acceptance), `report/datatables/sales_data.py:66` (external_acceptance), `report/templates/orders/daily_tracker.html` (external_acceptance), `report/templates/orders/hyperlocal_daily_report.html` (external_acceptance), `report/templates/orders/hyperlocal_data.html` (external_acceptance), `report/templates/orders/hyperlocal_order_accept_report.html` (external_acceptance), `report/templates/orders/nps_data.html` (external_acceptance), `report/templates/orders/orders_data.html` (external_acceptance), `report/templates/orders/return_orders.html` (external_acceptance), `report/templates/performance_report/cashier_performance.html` (external_acceptance), `report/templates/performance_report/salesperson_performance.html` (external_acceptance), `report/templates/sales/index.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/operational-reports/performance.tsx:47` | Actual performance page selects the queued source-screen CSV kind; cashier has its distinct registered kind. |
| `frontend/src/pages/operational-reports/acceptance.tsx:30` | Actual hyperlocal acceptance page exposes the source CSV action through the common private queue. |
| `frontend/src/pages/operational-reports/report-view.tsx:140` | Actual visible-column export binds the submitted result filters/sort and current finite column selection; complete CSV remains a distinct action. |
| `backend/src/modules/operational-reports/export-presentation.ts:68` | Finite per-screen presentation allowlists reject arbitrary SQL/unknown/duplicate columns and preserve source column order. |
| `backend/src/modules/operational-reports/export-service.ts:98` | Actual worker builder dispatches performance/acceptance and selected-screen variants; unmarked full export retains its original query/layout. |
| `backend/src/modules/operational-reports/screen-report-csv.ts:10` | Bounded UTF-8 CSV includes all matching rows in selected sort and original visible-column order; no truncated artifact is published. |

### report-exports

Mapped surfaces: `report/urls.py:91` (external_acceptance), `report/urls.py:92` (external_acceptance), `report/datatables/cash_balance_datatable.py:83` (external_acceptance), `report/datatables/day_close_datatable.py:216` (external_acceptance), `report/datatables/hyperlocal_daily_datatable.py:40` (external_acceptance), `report/datatables/inventory_datatable.py:60` (external_acceptance), `report/datatables/return_orders_datatable.py:63` (external_acceptance), `report/datatables/return_orders_datatable.py:328` (external_acceptance), `report/datatables/sales_data.py:66` (external_acceptance), `report/templates/export/index.html` (external_acceptance).

| Code/source reference | Reviewed scope |
| --- | --- |
| `frontend/src/pages/operational-reports/exports.tsx:115` | Actual export-history screen exports only selected metadata columns from its loaded authorized page, with no file-key/URL fetch or recursive export-of-exports job. |
| `frontend/src/pages/operational-reports/export-metadata.ts:47` | Finite bounded metadata CSV preserves static safe messages and formula/UTF-8 guards; raw legacy error messages and file keys stay excluded. |

### legacy-order-imports

Mapped surfaces: `core/tasks.py:51` (external_acceptance), `core/tasks.py:62` (external_acceptance), `core/templates/order_punch/index.html` (external_acceptance), `core/templates/shopify_order_punch/index.html` (external_acceptance), `core/templates/upload_logs/index.html` (missing).

| Code/source reference | Reviewed scope |
| --- | --- |
| `backend/src/modules/checkout/cancellations/membership-fence.ts:94` | Actual shared membership fence consumes authenticated fixed-function revision metadata under application authority without TRIGGER privileges, retaining exact bodies, native indexes/collations and revision semantics. Go/Python counterparts and independent-account workflow fixtures are integrated; this is not deployed or full-project certification. |
| `backend/src/app.ts:361` | Actual application registration invokes the production import factory; the profile is not a standalone unused constructor. |
| `backend/src/modules/legacy-order-imports/worker-main.ts:72` | Standalone production worker uses that same configured import factory and its selected/blocked profile decisions. |
| `backend/src/modules/legacy-order-imports/runtime.ts:23` | Actual server and worker registration composes preparation, benefits, approvals, corrections and the selected screening profile. |
| `backend/src/modules/legacy-order-imports/worker.ts:20` | Bounded production worker replaces the offline/Shopify source task entry points; original operation outcomes remain durable. |
| `frontend/src/pages/administration/order-imports/index.tsx:45` | Actual role-bound offline/Shopify forms and saved job/results recovery implement the requested import workflow; the separate commented upload-log page has its explicit inactive disposition below. |
| `backend/src/modules/legacy-order-imports/financial-adapter-profiles.ts:129` | Actual financial dispatch hooks compose selected membership/benefit and screening reservation/receipt/completion gates. |
| `backend/compatibility/upstream/legacy-order-imports/source_runtime.py:270` | Private source installs the real membership writer and PosOrder staging composition, including Shopify pending semantics. |
| `backend/compatibility/upstream/legacy-order-imports/membership_profile.py:134` | Pinned membership setters run through the existing stage/provenance producer; free membership additions/replacements require source causality. |
| `backend/src/modules/legacy-order-imports/membership-profile/adapter.ts:242` | Node authenticates staged/current membership descriptors and freezes completion provenance instead of assuming entitlements. |
| `backend/compatibility/upstream/legacy-order-imports/legacy_import_membership_reference.go:155` | Actual Go confirmation uses imported membership activation/reference checks before original native mutation. |
| `backend/src/modules/legacy-order-imports/benefit-profile/composition.ts:93` | Server financial hooks reduce only proved membership/coupon/complementary ownership and retain exact source/native hashes. |
| `backend/compatibility/upstream/legacy-order-imports/benefit-profile/benefit_runtime.py:48` | Private source composes literal birthday-coupon and POS complementary selection, native receipts and current control/history validation. |
| `backend/compatibility/upstream/legacy-order-imports/benefit-profile/benefit_profile.py:133` | Allows only declared POS selections and causally proved membership additions; unbound wallet/GV/PG values remain deliberately refused. |
| `backend/compatibility/upstream/legacy-order-imports/coupon_consumption.go:233` | Go confirmation binds actual coupon consumption to the authenticated source benefit descriptor in the native transaction. |
| `backend/src/modules/legacy-order-imports/screening-runtime.ts:21` | Actual runtime selection requires the reviewed contracts, complete current counter/head configuration and explicit server-owned 0/1 line mode. |
| `backend/compatibility/upstream/legacy-order-imports/runtime.py:100` | The real private WSGI factory now wraps its actual SourceRuntime, closing the previous uncalled-profile integration gap. |
| `backend/compatibility/upstream/legacy-order-imports/screening_runtime.py:49` | Source compares its actual line-item setting before installing the real ScreeningSourceRuntime; no silent enabled default. |
| `backend/compatibility/upstream/legacy-order-imports/screening_profile.py:231` | Only the verified CSV capability/plan hands its exact historical timestamp to the creation writer; public/default callers have no override authority. |
| `backend/compatibility/upstream/legacy-order-imports/screening_counter.py:220` | Native after-flush provenance restricts the source replay to this attempt’s actual new order/lines; matching customer IDs alone do not authorize historical reads or updates. |
| `backend/src/modules/screening-origins/native-head-capacity.ts:8` | Shared generated row/UTF-8-byte/metadata budgets keep the actual native writer privilege catalog representable; capacity never authorizes roles, proxies, unsafe grants or head mutation. |
| `backend/compatibility/upstream/legacy-order-imports/screening_head_metadata.go:328` | Actual Go financial transactions freshly authenticate full native writer/head metadata with retained locks, closed participant authority, roles/proxies and exact fixed readonly routines. |
| `backend/src/modules/legacy-order-imports/correction-repository.ts:57` | Approved manager workflow retains immutable original input/no-effect proof and records the corrected successor under current manager authority. |
| `backend/compatibility/upstream/legacy-order-imports/correction_profile.py:43` | Private source independently authenticates the retained correction/calculation and definite original no-effect boundary before using corrected tender. |
| `frontend/src/pages/administration/order-imports/ImportCorrectionPanel.tsx:81` | Actual manager review/attestation/recovery UI is integrated; the alternate dual-value review candidate does not execute financial work. |

### inactive-upload-logs

Mapped surfaces: `core/templates/upload_logs/index.html` (missing).

| Code/source reference | Reviewed scope |
| --- | --- |
| `core/urls.py:49` | Both upload-log list/AJAX routes are commented at the source pin; no active source page request reaches the retained template. |
| `core/views.py:744` | The source list/render class is commented rather than an executable leaf. |
| `core/datatables/upload_logs_datatable.py:11` | The entire retained source datatable class is commented. |
| `core/urls.py:73` | Independent failed-record download route is also commented; it is not an active leaf hidden behind an inactive page. |
| `core/views.py:1137` | The failed-record download handler is commented; the retained template link does not establish executable download behavior. |

### source-diagnostic-task

Mapped surfaces: `stores/tasks.py:11` (missing).

| Code/source reference | Reviewed scope |
| --- | --- |
| `stores/tasks.py:11` | Diagnostic prints generated values; the actual create_user call is commented. No account-writing replacement is required or selected. |

### business-metrics-upload

Mapped surfaces: `report/templates/bd_report/daily_report_matric_report_datatable.html` (missing), `report/templates/bd_report/daily_report_matric_upload.html` (missing).

| Code/source reference | Reviewed scope |
| --- | --- |
| `report/views.py:1350` | Upload/render class is commented source text, without an executable view or active route. |
| `report/datatables/bd_report.py:16` | Preview/datatable class is commented. Both prototype templates stay missing/inactive inventory exclusions, not a new upload product. |


Any remaining code gaps are distinct from configured provider acceptance. Parent/store archive/reactivation retains stable financial identities per the user clarification; generic physical Store/PosUser deletion is not a missing active feature. `create_random_user_accounts_new` only prints generated credentials with its actual account insert commented out: its missing replacement is a diagnostic-only inventory item, not a newly required credential-logging or mass-account product feature.

## Implementation/acceptance counts

| Kind | Present | Partial | Missing | External acceptance |
| --- | ---: | ---: | ---: | ---: |
| routes | 68 | 0 | 0 | 187 |
| jobs | 0 | 0 | 1 | 31 |
| templates | 32 | 0 | 3 | 71 |
| websockets | 0 | 0 | 0 | 1 |
| administration | 0 | 0 | 0 | 2 |

“External acceptance” means code exists and the named real dependency remains unaccepted. It does not turn a missing callback/financial adapter into a deployed feature. Warehouse absence, source collation/generation proofs, shared writer patches, physical printers, real OAuth/SMS/mail and SDD/legal rendering are carried at their specific family boundaries in the JSON; they are not hundreds of invented code tasks.

## Source-to-replacement ledger

Each row below links to family IDs in `source-surface-map.json`; those families list current backend/frontend modules, test files/directories, source evidence and exact code/external gaps. Original IDs and unverified status are retained unchanged. A mapped template means the corresponding React feature is accounted for, not that every original DOM transition has been certified.

### routes

| Source | Surface | Families | Implementation disposition |
| --- | --- | --- | --- |
| `POSAdmin/urls.py:10` | `tssposadmin_iWkhI8vhgTn/` | model-administration-access | external_acceptance |
| `POSAdmin/urls.py:11` | `login` | identity | external_acceptance |
| `core/urls.py:17` | `health/` | system-health | implementation_present |
| `core/urls.py:19` | `stock-management/` | inventory | external_acceptance |
| `core/urls.py:20` | `stock-management/bulk-upload/` | inventory-imports | external_acceptance |
| `core/urls.py:26` | `products/<int:product_id>/hold-stock-inventory-logs/` | inventory-audit | external_acceptance |
| `core/urls.py:31` | `get-country-name/` | country-search | implementation_present |
| `core/urls.py:34` | `products/` | catalog-read | external_acceptance |
| `core/urls.py:35` | `ajax-products-list/` | catalog-read | external_acceptance |
| `core/urls.py:36` | `products/<int:product_id>/show/` | catalog-read | external_acceptance |
| `core/urls.py:37` | `products/<int:product_id>/inventory-logs/` | inventory, inventory-audit | external_acceptance |
| `core/urls.py:38` | `ajax-product-inventory-list/` | inventory, inventory-audit | external_acceptance |
| `core/urls.py:40` | `ajax-change-product-status/` | inventory | external_acceptance |
| `core/urls.py:43` | `ajax-product-stock-list/` | inventory | external_acceptance |
| `core/urls.py:45` | `ajax-order-product-stock-list/` | pos-catalog | external_acceptance |
| `core/urls.py:47` | `assign-product-stock/` | inventory | external_acceptance |
| `core/urls.py:53` | `salespersons/` | salespeople | implementation_present |
| `core/urls.py:54` | `ajax-salespersons-list/` | salespeople | implementation_present |
| `core/urls.py:55` | `ajax-archived-salespersons-list/` | salespeople | implementation_present |
| `core/urls.py:56` | `salespersons/create/` | salespeople | implementation_present |
| `core/urls.py:57` | `salespersons/<int:pk>/edit/` | salespeople | implementation_present |
| `core/urls.py:58` | `salesperson/<int:pk>/delete/` | salespeople | implementation_present |
| `core/urls.py:59` | `salesperson/<int:pk>/activate/` | salespeople | implementation_present |
| `core/urls.py:60` | `salesperson/<int:pk>/assign-store/` | salespeople | implementation_present |
| `core/urls.py:62` | `spl-permission/` | special-permission-history, global-barcode-assignment | external_acceptance |
| `core/urls.py:63` | `special_permission_data/` | special-permission-history | external_acceptance |
| `core/urls.py:66` | `ajax-get-quotes/` | motivational-quotes | implementation_present |
| `core/urls.py:67` | `ajax-add-barcode/` | global-barcode-assignment | external_acceptance |
| `core/urls.py:68` | `ajax-tss-money/` | wallet-adjustments | external_acceptance |
| `core/urls.py:69` | `ajax-tss-points/` | wallet-adjustments | external_acceptance |
| `core/urls.py:70` | `ajax-gift-voucher-module/` | global-vouchers | external_acceptance |
| `core/urls.py:79` | `inventory-sync/` | catalog-maintenance | external_acceptance |
| `core/urls.py:82` | `catalogue/store/<int:store_id>/show` | catalog-read | external_acceptance |
| `core/urls.py:83` | `ajax-catalogue/store/<int:store_id>/show` | catalog-read | external_acceptance |
| `core/urls.py:86` | `delivery-timings/` | support | implementation_present |
| `core/urls.py:87` | `delivery-timings/create/` | support | implementation_present |
| `core/urls.py:88` | `delivery-timings/<int:pk>/edit/` | support | implementation_present |
| `core/urls.py:89` | `ajax-update-delivery-slots/` | support | implementation_present |
| `core/urls.py:90` | `catalogue/store/<int:store_id>/show` | catalog-read | external_acceptance |
| `core/urls.py:91` | `ajax-catalogue/store/<int:store_id>/show` | catalog-read | external_acceptance |
| `core/urls.py:92` | `offline-billing/store/<int:store_id>/` | offline-scratch-invoice | external_acceptance |
| `core/urls.py:93` | `get-product-dropdown/<int:store_id>/` | offline-scratch-invoice | external_acceptance |
| `core/urls.py:94` | `settings/general/` | support | implementation_present |
| `core/urls.py:95` | `ajax-threshold-update/` | support | implementation_present |
| `core/urls.py:96` | `ajax-order-buffer-update/` | support | implementation_present |
| `core/urls.py:99` | `settings/ecom/` | ecommerce-inventory-sync, support | external_acceptance |
| `core/urls.py:100` | `ajax-ecom-setting-update/` | ecommerce-inventory-sync, support | external_acceptance |
| `core/urls.py:103` | `gift-card-management/` | gift-card-batches | external_acceptance |
| `core/urls.py:104` | `ajax-gift-card-list/` | gift-card-batches | external_acceptance |
| `core/urls.py:105` | `ajax-generate-gift-card/` | gift-card-batches | external_acceptance |
| `core/urls.py:106` | `ajax-print-gift-card/` | gift-card-batches | external_acceptance |
| `core/urls.py:107` | `ajax-block-gift-card/` | gift-card-batches | external_acceptance |
| `core/urls.py:113` | `products/<int:product_id>/storage-stock-inventory-logs/` | inventory-audit | external_acceptance |
| `core/urls.py:114` | `ajax-storage-stock-inventory-list/` | inventory-audit | external_acceptance |
| `core/urls.py:119` | `ajax-get-checkin-data/` | check-in | implementation_present |
| `core/urls.py:120` | `ajax-set-checkin-data/` | check-in | implementation_present |
| `core/urls.py:123` | `documentation-lists/` | documentation | external_acceptance |
| `core/urls.py:124` | `documentation-detail/` | documentation | external_acceptance |
| `core/urls.py:125` | `documentation-datatable-lists/` | documentation | external_acceptance |
| `core/urls.py:126` | `ajax-documentation-lists/` | documentation | external_acceptance |
| `core/urls.py:127` | `upload-or-edit-tutorial/` | documentation | external_acceptance |
| `core/urls.py:129` | `disable-tutorial/` | documentation | external_acceptance |
| `core/urls.py:131` | `edc-machine-edit-detail/` | terminals | implementation_present |
| `core/urls.py:132` | `ajax-edc-machine-edit-detail/` | terminals | implementation_present |
| `core/urls.py:135` | `add-paytm-machine/` | terminals | implementation_present |
| `core/urls.py:136` | `add_pinelab_machine/` | terminals | implementation_present |
| `core/urls.py:137` | `ajax-next-edc-machine-name/` | terminals | implementation_present |
| `core/urls.py:140` | `edit-paytm-machine/<int:pk>/` | terminals | implementation_present |
| `core/urls.py:141` | `edit-pinelab-machine/<int:pk>/` | terminals | implementation_present |
| `core/urls.py:144` | `delete-paytm-machine/<int:pk>/` | terminals | implementation_present |
| `core/urls.py:145` | `delete-pinelab-machine/<int:pk>/` | terminals | implementation_present |
| `core/urls.py:148` | `mpos-download-qr/` | staff-installer-handoff | external_acceptance |
| `core/urls.py:149` | `ajax-gen-mpos-download-qr/` | staff-installer-handoff | external_acceptance |
| `core/urls.py:150` | `mpos-download-thank-you/` | staff-installer-handoff | external_acceptance |
| `core/urls.py:151` | `mpos-download-link/` | staff-installer-handoff | external_acceptance |
| `core/urls.py:154` | `ajax-troubleshoot-product/` | catalog-maintenance | external_acceptance |
| `core/urls.py:157` | `mpos_payment_mode` | payments | external_acceptance |
| `core/urls.py:158` | `mpos_edc_pay_init` | payments | external_acceptance |
| `core/urls.py:159` | `mpos_edc_status_check` | payments | external_acceptance |
| `core/urls.py:160` | `mpos_edc_pay_cancel` | payments | external_acceptance |
| `core/urls.py:163` | `user_download_app_qr` | customer-application-handoff | external_acceptance |
| `core/urls.py:164` | `user_to_app` | customer-application-handoff | external_acceptance |
| `core/urls.py:165` | `download-demo/` | catalog-maintenance | external_acceptance |
| `core/urls.py:167` | `get-location-by-pincode/` | postal-code-location | implementation_present |
| `dashboard/urls.py:7` | `dashboard` | dashboard-summary | external_acceptance |
| `dashboard/urls.py:8` | `shortcut` | motivational-quotes, shared-shell | implementation_present |
| `dashboard/urls.py:9` | `ajax-feed-live-internet-speed/` | shared-shell | implementation_present |
| `dashboard/urls.py:10` | `ajax-live-internet-data/` | shared-shell | implementation_present |
| `notification/urls.py:7` | `ajax-notification-update/` | notifications | external_acceptance |
| `order/urls.py:8` | `store/` | orders-read | external_acceptance |
| `order/urls.py:9` | `online/` | orders-read | external_acceptance |
| `order/urls.py:10` | `ajax-order-list/` | orders-read | external_acceptance |
| `order/urls.py:11` | `store/<int:order_id>/show/` | orders-read | external_acceptance |
| `order/urls.py:12` | `online/<int:order_id>/show/` | orders-read | external_acceptance |
| `order/urls.py:13` | `store/<int:order_id>/invoice/` | invoice-documents | external_acceptance |
| `order/urls.py:14` | `online/<int:order_id>/invoice/` | invoice-documents | external_acceptance |
| `order/urls.py:15` | `online_sdd/<int:order_id>/invoice/` | invoice-documents | external_acceptance |
| `order/urls.py:16` | `ajax-get-sub-reasons/` | returns-exchanges | external_acceptance |
| `order/urls.py:17` | `ajax-get-pay-amt/` | returns-exchanges | external_acceptance |
| `order/urls.py:18` | `ajax-product-return/` | returns-exchanges | external_acceptance |
| `order/urls.py:19` | `ajax-product-exchange/` | returns-exchanges | external_acceptance |
| `order/urls.py:20` | `ajax-get-exchange-sizes/` | returns-exchanges | external_acceptance |
| `order/urls.py:21` | `ajax-get-exchange-reasons/` | returns-exchanges | external_acceptance |
| `order/urls.py:22` | `tab/` | motivational-quotes, checkout-cart | external_acceptance |
| `order/urls.py:23` | `create-order/<int:store_id>/<int:counter_id>/<int:tab_id>/` | motivational-quotes, checkout-cart, cashier-shortcuts, order-to-cart-copy, customer-website-handoff | external_acceptance |
| `order/urls.py:24` | `ajax-cart/` | checkout-cart | external_acceptance |
| `order/urls.py:25` | `ajax-sync-cart/` | checkout-cart | external_acceptance |
| `order/urls.py:26` | `ajax-wallet/` | checkout-cart | external_acceptance |
| `order/urls.py:27` | `ajax-pg-discount/` | checkout-cart | external_acceptance |
| `order/urls.py:28` | `ajax-store-discount-pg/` | checkout-cart | external_acceptance |
| `order/urls.py:29` | `ajax-exclusive-benefits/` | checkout-cart | external_acceptance |
| `order/urls.py:30` | `ajax-gift-voucher/` | checkout-cart | external_acceptance |
| `order/urls.py:31` | `ajax-coupon/` | checkout-cart | external_acceptance |
| `order/urls.py:32` | `ajax-user-register/` | checkout-cart | external_acceptance |
| `order/urls.py:33` | `ajax-send-otp/` | customer-verification | external_acceptance |
| `order/urls.py:34` | `ajax-verify-otp/` | customer-verification | external_acceptance |
| `order/urls.py:35` | `ajax-validate-process-order/` | checkout-cart | external_acceptance |
| `order/urls.py:36` | `ajax-order/` | checkout-cart, order-messages | external_acceptance |
| `order/urls.py:37` | `ajax-order-cancel/` | pending-order-cancellation | external_acceptance |
| `order/urls.py:38` | `ajax-add-salesperson/` | checkout-cart | external_acceptance |
| `order/urls.py:39` | `ajax-add-salesperson-per-product/` | checkout-cart | external_acceptance |
| `order/urls.py:40` | `ajax-payment-status/` | legacy-paid-reversal | external_acceptance |
| `order/urls.py:41` | `ajax-check-save-gc/` | purchased-gift-cards | external_acceptance |
| `order/urls.py:42` | `ajax-save-gc-date/` | purchased-gift-cards | external_acceptance |
| `order/urls.py:43` | `ajax-extend-return/` | returns-exchanges | external_acceptance |
| `order/urls.py:46` | `ajax-transaction-upload/` | payments | external_acceptance |
| `order/urls.py:47` | `ajax-transaction-cancel/` | payments | external_acceptance |
| `order/urls.py:48` | `ajax-transaction-status-check/` | payments | external_acceptance |
| `order/urls.py:49` | `paytm-ajax-transaction-cancel/` | payments | external_acceptance |
| `order/urls.py:50` | `ajax-transaction-status-check-paytm/` | payments | external_acceptance |
| `order/urls.py:51` | `ajax-get-payment-mode-by-order-id/` | payments | external_acceptance |
| `order/urls.py:54` | `ajax-fast-checkout/` | fast-cash | external_acceptance |
| `order/urls.py:57` | `key-shortcuts/` | cashier-shortcuts | implementation_present |
| `order/urls.py:58` | `ajax-m-user-mobile` | customer-contacts | external_acceptance |
| `order/urls.py:59` | `ajax-m-user-email` | customer-contacts | external_acceptance |
| `order/urls.py:60` | `ajax-add-feedback/` | product-feedback | implementation_present |
| `order/urls.py:63` | `ajax-hl-order/` | local-deliveries | external_acceptance |
| `order/urls.py:64` | `auto-hl-order/` | local-deliveries | external_acceptance |
| `order/urls.py:65` | `ajax-convert-online/` | local-deliveries | external_acceptance |
| `order/urls.py:66` | `ajax-rto-recieved/` | local-deliveries | external_acceptance |
| `order/urls.py:67` | `ajax-order-pack/` | local-deliveries | external_acceptance |
| `order/urls.py:68` | `online/<int:order_id>/shipping/` | shipping-labels | external_acceptance |
| `order/urls.py:69` | `ajax-pass-order/` | local-deliveries | external_acceptance |
| `order/urls.py:72` | `webhook-cancelled-order/` | local-deliveries | external_acceptance |
| `order/urls.py:75` | `ajax-check-order-status/` | local-deliveries | external_acceptance |
| `order/urls.py:78` | `ajax-fetch-the-products/` | order-to-cart-copy | external_acceptance |
| `order/urls.py:80` | `ajax-update-status-vinc/` | legacy-vinculum-status | external_acceptance |
| `order/urls.py:82` | `ajax-online-order/` | customer-website-handoff | external_acceptance |
| `order/urls.py:85` | `ajax-gift-voucher-check/` | global-vouchers | external_acceptance |
| `order/urls.py:86` | `ajax-gift-voucher-convert/` | global-vouchers | external_acceptance |
| `order/urls.py:88` | `ajax-pg-disc-otp-send/` | discount-approval | external_acceptance |
| `order/urls.py:90` | `ajax-pg-disc-otp-check/` | discount-approval | external_acceptance |
| `order/urls.py:93` | `ajax-express-line-item-pack/` | express-fulfillment | external_acceptance |
| `order/urls.py:96` | `hyperlocal/progress/` | express-fulfillment | external_acceptance |
| `order/urls.py:97` | `ajax-hyperlocal-progress-data/` | express-fulfillment | external_acceptance |
| `order/urls.py:98` | `ajax-hyperlocal-progress-content/` | express-fulfillment | external_acceptance |
| `order/urls.py:99` | `ajax-hyperlocal-rejection-reasons/` | express-fulfillment | external_acceptance |
| `order/urls.py:100` | `ajax-express-line-items-bulk-action/` | express-fulfillment | external_acceptance |
| `order/urls.py:101` | `ajax-express-order-pack-all/` | express-fulfillment | external_acceptance |
| `order/urls.py:102` | `ajax-express-order-mark-shipped/` | express-fulfillment | external_acceptance |
| `order/urls.py:103` | `ajax-express-order-notify/` | express-fulfillment | external_acceptance |
| `order/urls.py:104` | `ajax-hyperlocal-load-more/` | express-fulfillment | external_acceptance |
| `order/urls.py:105` | `ajax-express-order-mark-rto/` | express-fulfillment | external_acceptance |
| `order/urls.py:107` | `ajax-hyperlocal-expiry-alerts/` | express-fulfillment | external_acceptance |
| `order/urls.py:110` | `hyperlocal/all-stores/` | express-fulfillment | external_acceptance |
| `order/urls.py:111` | `ajax-hyperlocal-all-stores-data/` | express-fulfillment | external_acceptance |
| `order/urls.py:112` | `ajax-hl-admin-edit/` | express-fulfillment | external_acceptance |
| `order/urls.py:113` | `ship-express-order/` | express-fulfillment | external_acceptance |
| `report/urls.py:16` | `api/v1/reconciliation/<str:feed_type>/` | finance-day-close | external_acceptance |
| `report/urls.py:19` | `return-orders/` | operational-reports | external_acceptance |
| `report/urls.py:20` | `ajax-return-order-list/` | operational-reports | external_acceptance |
| `report/urls.py:21` | `orders-data/` | operational-reports | external_acceptance |
| `report/urls.py:22` | `ajax-orders-data-list/` | operational-reports | external_acceptance |
| `report/urls.py:27` | `ajax-troubleshoot-inventory/` | inventory-parent-repair | implementation_present |
| `report/urls.py:31` | `ajax-nps-data-list/` | operational-reports | external_acceptance |
| `report/urls.py:36` | `order-hyperlocal-accept-report/` | operational-reports | external_acceptance |
| `report/urls.py:37` | `ajax-hyperlocal-order-accept-report/` | operational-reports | external_acceptance |
| `report/urls.py:40` | `hyperlocal-slack-report/` | scheduled-reports | external_acceptance |
| `report/urls.py:41` | `hyperlocal-availability-report/` | scheduled-reports | external_acceptance |
| `report/urls.py:42` | `hyperlocal-store-status-report/` | scheduled-reports | external_acceptance |
| `report/urls.py:43` | `hyperlocal-delivery-report` | scheduled-reports | external_acceptance |
| `report/urls.py:44` | `hyperlocal-cancellation-report/` | scheduled-reports | external_acceptance |
| `report/urls.py:45` | `crm-ticket-status/` | scheduled-reports | external_acceptance |
| `report/urls.py:51` | `salesperson-performance-report/` | operational-reports | external_acceptance |
| `report/urls.py:52` | `ajax-salesperson-performance-report/` | operational-reports | external_acceptance |
| `report/urls.py:53` | `cashier-performance-report/` | operational-reports | external_acceptance |
| `report/urls.py:54` | `ajax-cashier-performance-report/` | operational-reports | external_acceptance |
| `report/urls.py:65` | `sales-data/` | operational-reports | external_acceptance |
| `report/urls.py:66` | `ajax-sales-data/` | operational-reports | external_acceptance |
| `report/urls.py:69` | `daily-store-report/` | daily-store-report | external_acceptance |
| `report/urls.py:70` | `ajax-daily-store-report/` | daily-store-report | external_acceptance |
| `report/urls.py:73` | `day-close/` | finance-day-close | external_acceptance |
| `report/urls.py:74` | `ajax-day-close-state/` | finance-day-close | external_acceptance |
| `report/urls.py:75` | `ajax-day-close-submit/` | finance-day-close | external_acceptance |
| `report/urls.py:76` | `ajax-day-close-nag/` | finance-day-close | external_acceptance |
| `report/urls.py:77` | `day-close-pending-alert/` | finance-day-close | external_acceptance |
| `report/urls.py:78` | `day-close-logs/` | finance-day-close | external_acceptance |
| `report/urls.py:79` | `ajax-day-close-logs/` | finance-day-close | external_acceptance |
| `report/urls.py:80` | `day-close-cash-balance/` | finance-day-close | external_acceptance |
| `report/urls.py:81` | `ajax-day-close-cash-balance/` | finance-day-close | external_acceptance |
| `report/urls.py:84` | `store-hyperlocal-record/` | scheduled-reports | external_acceptance |
| `report/urls.py:87` | `hyperlocal-reports/daily-report/` | operational-reports | external_acceptance |
| `report/urls.py:88` | `ajax-hyperlocal-daily-export/` | operational-reports | external_acceptance |
| `report/urls.py:91` | `export-logs/` | report-exports | external_acceptance |
| `report/urls.py:92` | `ajax-export-logs/` | report-exports | external_acceptance |
| `stores/urls.py:8` | `stores` | stores | implementation_present |
| `stores/urls.py:9` | `ajax-store-list/` | stores | implementation_present |
| `stores/urls.py:10` | `ajax-archived-store-list/` | stores | implementation_present |
| `stores/urls.py:11` | `create/` | stores, store-images | external_acceptance |
| `stores/urls.py:12` | `add-location/` | location-codes | implementation_present |
| `stores/urls.py:13` | `<int:pk>/view/` | stores | implementation_present |
| `stores/urls.py:14` | `<int:pk>/edit/` | stores, store-images | external_acceptance |
| `stores/urls.py:15` | `<int:pk>/delete/` | stores | implementation_present |
| `stores/urls.py:16` | `<int:pk>/activate/` | stores | implementation_present |
| `stores/urls.py:17` | `slack/connect/` | store-slack-oauth | external_acceptance |
| `stores/urls.py:18` | `slack/callback/` | store-slack-oauth | external_acceptance |
| `stores/urls.py:21` | `storages` | storage | implementation_present |
| `stores/urls.py:22` | `ajax-store-storage-list/` | storage | implementation_present |
| `stores/urls.py:23` | `ajax-archived-store-storage-list/` | storage | implementation_present |
| `stores/urls.py:24` | `storage/create/` | storage | implementation_present |
| `stores/urls.py:25` | `storage/<int:pk>/view/` | storage | implementation_present |
| `stores/urls.py:26` | `storage/<int:pk>/edit/` | storage | implementation_present |
| `stores/urls.py:27` | `storage/<int:pk>/delete/` | storage | implementation_present |
| `stores/urls.py:28` | `storage/<int:pk>/activate/` | storage | implementation_present |
| `stores/urls.py:31` | `counters` | counters | implementation_present |
| `stores/urls.py:32` | `ajax-counters-list/` | counters | implementation_present |
| `stores/urls.py:33` | `ajax-archived-counters-list/` | counters | implementation_present |
| `stores/urls.py:34` | `counters/create/` | counters | implementation_present |
| `stores/urls.py:35` | `counters/<int:pk>/delete/` | counters | implementation_present |
| `stores/urls.py:36` | `counters/<int:pk>/activate/` | counters | implementation_present |
| `users/urls.py:8` | `login/` | identity | external_acceptance |
| `users/urls.py:9` | `ajax-send-login-otp/` | identity | external_acceptance |
| `users/urls.py:10` | `ajax-mfa-login/` | identity | external_acceptance |
| `users/urls.py:11` | `logout/` | identity | external_acceptance |
| `users/urls.py:12` | `profile/` | self-profile | external_acceptance |
| `users/urls.py:13` | `password-change/` | self-profile | external_acceptance |
| `users/urls.py:14` | `users_list_view` | operators | implementation_present |
| `users/urls.py:15` | `ajax-users-list/` | operators | implementation_present |
| `users/urls.py:16` | `ajax-archived-users-list/` | operators | implementation_present |
| `users/urls.py:17` | `create/` | operators | implementation_present |
| `users/urls.py:18` | `<int:pk>/edit/` | operators | implementation_present |
| `users/urls.py:19` | `<int:pk>/delete/` | operators | implementation_present |
| `users/urls.py:20` | `<int:pk>/activate/` | operators | implementation_present |
| `users/urls.py:21` | `<int:user_id>/assign-store` | operators | implementation_present |
| `users/urls.py:22` | `get-user-details` | customer-workspace | external_acceptance |
| `users/urls.py:23` | `update-user` | customer-workspace | external_acceptance |
| `users/urls.py:24` | `get-user-behaviour` | customer-workspace | external_acceptance |
| `users/urls.py:25` | `ajax-customer-insight` | customer-workspace | external_acceptance |
| `users/urls.py:26` | `<int:pk>/activate-mfa/` | operator-mfa | implementation_present |
| `users/urls.py:27` | `activate-mfa/` | operator-mfa | implementation_present |
| `users/urls.py:28` | `ajax-update-user-data/` | customer-workspace | external_acceptance |
| `users/urls.py:29` | `order-feedback-form/<int:user_id>/<int:order_id>` | product-feedback | implementation_present |
| `users/urls.py:30` | `mpos-login/` | device-signin | external_acceptance |
| `users/urls.py:33` | `auth-qr-gen/` | device-signin | external_acceptance |
| `users/urls.py:34` | `ajax-gen-auth-qr/` | device-signin | external_acceptance |

### jobs

| Source | Surface | Families | Implementation disposition |
| --- | --- | --- | --- |
| `core/tasks.py:29` | `parse_csv_product_store` | parent-store-assignment-csv | external_acceptance |
| `core/tasks.py:40` | `parse_csv_product_stock` | inventory-imports | external_acceptance |
| `core/tasks.py:51` | `parse_csv_offline_order_punchin` | legacy-order-imports | external_acceptance |
| `core/tasks.py:62` | `parse_csv_shopify_order_punchin` | legacy-order-imports | external_acceptance |
| `core/tasks.py:71` | `send_sms` | order-messages | external_acceptance |
| `core/tasks.py:84` | `send_login_otp` | identity | external_acceptance |
| `core/tasks.py:147` | `accept_order` | local-deliveries | external_acceptance |
| `core/tasks.py:159` | `reject_order` | local-deliveries | external_acceptance |
| `core/tasks.py:171` | `new_order_create_communication` | local-deliveries | external_acceptance |
| `core/tasks.py:182` | `sync_ecom_inventory` | ecommerce-inventory-sync | external_acceptance |
| `core/tasks.py:209` | `generate_and_upload_gift_card` | gift-card-batches | external_acceptance |
| `core/tasks.py:226` | `push_vinc_order_for_all` | legacy-vinculum-status | external_acceptance |
| `core/tasks.py:232` | `send_pg_disc_otp` | discount-approval | external_acceptance |
| `core/tasks.py:271` | `pg_disc_otp_applied_email` | discount-approval | external_acceptance |
| `order/tasks.py:150` | `auto_reject_timed_out_for_store` | express-fulfillment | external_acceptance |
| `order/views.py:3839` | `auto_hl_order_create` | local-deliveries | external_acceptance |
| `order/views.py:3845` | `auto_hl_order_transfer` | local-deliveries | external_acceptance |
| `order/views.py:3938` | `auto_hl_order_to_online` | local-deliveries | external_acceptance |
| `order/views.py:4482` | `advance_order_notification` | local-deliveries | external_acceptance |
| `report/datatables/cash_balance_datatable.py:83` | `do_cash_balance_export` | finance-day-close, report-exports | external_acceptance |
| `report/datatables/day_close_datatable.py:216` | `do_day_close_export` | finance-day-close, report-exports | external_acceptance |
| `report/datatables/hyperlocal_daily_datatable.py:40` | `do_hyperlocal_daily_export` | operational-reports, report-exports | external_acceptance |
| `report/datatables/inventory_datatable.py:60` | `do_return_export` | inventory-workbooks, report-exports | external_acceptance |
| `report/datatables/return_orders_datatable.py:63` | `do_return_export` | operational-reports, report-exports | external_acceptance |
| `report/datatables/return_orders_datatable.py:328` | `do_order_export` | operational-reports, report-exports | external_acceptance |
| `report/datatables/sales_data.py:66` | `do_sales_export` | operational-reports, report-exports | external_acceptance |
| `report/tasks.py:25` | `process_export_master` | inventory-workbooks | external_acceptance |
| `report/tasks.py:87` | `generate_store_excel_chunk` | inventory-workbooks | external_acceptance |
| `report/tasks.py:134` | `debug_print_result` | inventory-workbooks | external_acceptance |
| `report/tasks.py:139` | `merge_store_chunks` | inventory-workbooks | external_acceptance |
| `report/tasks.py:164` | `merge_all_stores_and_upload` | inventory-workbooks | external_acceptance |
| `stores/tasks.py:11` | `create_random_user_accounts_new` | source-diagnostic-task | missing |

### templates

| Source | Surface | Families | Implementation disposition |
| --- | --- | --- | --- |
| `core/templates/500.html` | `core/templates/500.html` | system-health | implementation_present |
| `core/templates/catalogue/index.html` | `core/templates/catalogue/index.html` | catalog-read | external_acceptance |
| `core/templates/delivery_timing/_form.html` | `core/templates/delivery_timing/_form.html` | support | implementation_present |
| `core/templates/delivery_timing/create.html` | `core/templates/delivery_timing/create.html` | support | implementation_present |
| `core/templates/delivery_timing/edit.html` | `core/templates/delivery_timing/edit.html` | support | implementation_present |
| `core/templates/delivery_timing/edit_form.html` | `core/templates/delivery_timing/edit_form.html` | support | implementation_present |
| `core/templates/delivery_timing/index.html` | `core/templates/delivery_timing/index.html` | support | implementation_present |
| `core/templates/documentation/_detail.html` | `core/templates/documentation/_detail.html` | documentation | external_acceptance |
| `core/templates/documentation/_form.html` | `core/templates/documentation/_form.html` | documentation | external_acceptance |
| `core/templates/documentation/create.html` | `core/templates/documentation/create.html` | documentation | external_acceptance |
| `core/templates/documentation/documentation_lists.html` | `core/templates/documentation/documentation_lists.html` | documentation | external_acceptance |
| `core/templates/documentation/index.html` | `core/templates/documentation/index.html` | documentation | external_acceptance |
| `core/templates/documentation/show.html` | `core/templates/documentation/show.html` | documentation | external_acceptance |
| `core/templates/ecom_delivery/index.html` | `core/templates/ecom_delivery/index.html` | support, ecommerce-inventory-sync | external_acceptance |
| `core/templates/edc_edit/edc_detail_and_edit.html` | `core/templates/edc_edit/edc_detail_and_edit.html` | terminals | implementation_present |
| `core/templates/gift_card/index.html` | `core/templates/gift_card/index.html` | gift-card-batches | external_acceptance |
| `core/templates/mpos_download/index.html` | `core/templates/mpos_download/index.html` | staff-installer-handoff | external_acceptance |
| `core/templates/mpos_download/thank_you.html` | `core/templates/mpos_download/thank_you.html` | staff-installer-handoff | external_acceptance |
| `core/templates/offline_billing/biller.html` | `core/templates/offline_billing/biller.html` | offline-scratch-invoice | external_acceptance |
| `core/templates/order_punch/index.html` | `core/templates/order_punch/index.html` | legacy-order-imports | external_acceptance |
| `core/templates/products/hold_stock/hold_inventory_logs.html` | `core/templates/products/hold_stock/hold_inventory_logs.html` | inventory-audit | external_acceptance |
| `core/templates/products/hold_stock/index.html` | `core/templates/products/hold_stock/index.html` | inventory-audit | external_acceptance |
| `core/templates/products/index.html` | `core/templates/products/index.html` | catalog-read | external_acceptance |
| `core/templates/products/inventory_logs.html` | `core/templates/products/inventory_logs.html` | inventory-audit | external_acceptance |
| `core/templates/products/stock/index.html` | `core/templates/products/stock/index.html` | catalog-read, inventory, inventory-imports | external_acceptance |
| `core/templates/products/stock/index_bak.html` | `core/templates/products/stock/index_bak.html` | catalog-read, inventory, inventory-imports | external_acceptance |
| `core/templates/products/stock/inventory-sync.html` | `core/templates/products/stock/inventory-sync.html` | catalog-maintenance | external_acceptance |
| `core/templates/products/storage_stock/index.html` | `core/templates/products/storage_stock/index.html` | inventory-audit | external_acceptance |
| `core/templates/products/storage_stock/storage_inventory_logs.html` | `core/templates/products/storage_stock/storage_inventory_logs.html` | inventory-audit | external_acceptance |
| `core/templates/products/store/index.html` | `core/templates/products/store/index.html` | catalog-read, parent-store-assignment-csv | external_acceptance |
| `core/templates/products/store/show.html` | `core/templates/products/store/show.html` | catalog-read, parent-store-assignment-csv | external_acceptance |
| `core/templates/salespersons/_form.html` | `core/templates/salespersons/_form.html` | salespeople | implementation_present |
| `core/templates/salespersons/create.html` | `core/templates/salespersons/create.html` | salespeople | implementation_present |
| `core/templates/salespersons/edit.html` | `core/templates/salespersons/edit.html` | salespeople | implementation_present |
| `core/templates/salespersons/index.html` | `core/templates/salespersons/index.html` | salespeople | implementation_present |
| `core/templates/settings/index.html` | `core/templates/settings/index.html` | support | implementation_present |
| `core/templates/shopify_order_punch/index.html` | `core/templates/shopify_order_punch/index.html` | legacy-order-imports | external_acceptance |
| `core/templates/special_permission/index.html` | `core/templates/special_permission/index.html` | special-permission-history, wallet-adjustments, global-vouchers, global-barcode-assignment | external_acceptance |
| `core/templates/upload_logs/index.html` | `core/templates/upload_logs/index.html` | inventory-imports, legacy-order-imports, parent-store-assignment-csv, inactive-upload-logs | missing |
| `core/templates/user_to_app/index.html` | `core/templates/user_to_app/index.html` | customer-application-handoff | external_acceptance |
| `dashboard/templates/dashboard/dashboard.html` | `dashboard/templates/dashboard/dashboard.html` | dashboard-summary | external_acceptance |
| `dashboard/templates/dashboard/main_dashboard.html` | `dashboard/templates/dashboard/main_dashboard.html` | shared-shell, motivational-quotes | implementation_present |
| `order/templates/order/_exchange_js.html` | `order/templates/order/_exchange_js.html` | returns-exchanges | external_acceptance |
| `order/templates/order/_hl_banner.html` | `order/templates/order/_hl_banner.html` | express-fulfillment, notifications | external_acceptance |
| `order/templates/order/add_order_feedback.html` | `order/templates/order/add_order_feedback.html` | product-feedback | implementation_present |
| `order/templates/order/basic_error.html` | `order/templates/order/basic_error.html` | system-health | implementation_present |
| `order/templates/order/create_order.html` | `order/templates/order/create_order.html` | checkout-cart, customer-workspace, customer-contacts, customer-verification, payments, fast-cash, cashier-shortcuts, order-to-cart-copy, customer-website-handoff, motivational-quotes | external_acceptance |
| `order/templates/order/hyperlocal/_all_stores_order_cards.html` | `order/templates/order/hyperlocal/_all_stores_order_cards.html` | express-fulfillment | external_acceptance |
| `order/templates/order/hyperlocal/_hl_eli_status_badge.html` | `order/templates/order/hyperlocal/_hl_eli_status_badge.html` | express-fulfillment | external_acceptance |
| `order/templates/order/hyperlocal/_hl_image_preview.html` | `order/templates/order/hyperlocal/_hl_image_preview.html` | express-fulfillment | external_acceptance |
| `order/templates/order/hyperlocal/_hl_line_items_table.html` | `order/templates/order/hyperlocal/_hl_line_items_table.html` | express-fulfillment | external_acceptance |
| `order/templates/order/hyperlocal/_order_cards.html` | `order/templates/order/hyperlocal/_order_cards.html` | express-fulfillment | external_acceptance |
| `order/templates/order/hyperlocal/_progress_content.html` | `order/templates/order/hyperlocal/_progress_content.html` | express-fulfillment | external_acceptance |
| `order/templates/order/hyperlocal/all_stores_dashboard.html` | `order/templates/order/hyperlocal/all_stores_dashboard.html` | express-fulfillment | external_acceptance |
| `order/templates/order/hyperlocal/progress.html` | `order/templates/order/hyperlocal/progress.html` | express-fulfillment | external_acceptance |
| `order/templates/order/index.html` | `order/templates/order/index.html` | orders-read, payments, returns-exchanges, pending-order-cancellation, local-deliveries | external_acceptance |
| `order/templates/order/invoice.html` | `order/templates/order/invoice.html` | invoice-documents | external_acceptance |
| `order/templates/order/online/_return_exchange_cells.html` | `order/templates/order/online/_return_exchange_cells.html` | orders-read, returns-exchanges, invoice-documents | external_acceptance |
| `order/templates/order/online/show.html` | `order/templates/order/online/show.html` | orders-read, returns-exchanges, invoice-documents | external_acceptance |
| `order/templates/order/shipping.html` | `order/templates/order/shipping.html` | shipping-labels | external_acceptance |
| `order/templates/order/shortcuts.html` | `order/templates/order/shortcuts.html` | cashier-shortcuts | implementation_present |
| `order/templates/order/show.html` | `order/templates/order/show.html` | orders-read, payments, returns-exchanges, pending-order-cancellation, local-deliveries, legacy-vinculum-status | external_acceptance |
| `order/templates/order/tab.html` | `order/templates/order/tab.html` | checkout-cart, motivational-quotes | external_acceptance |
| `report/templates/bd_report/daily_report_matric_report_datatable.html` | `report/templates/bd_report/daily_report_matric_report_datatable.html` | business-metrics-upload | missing |
| `report/templates/bd_report/daily_report_matric_upload.html` | `report/templates/bd_report/daily_report_matric_upload.html` | business-metrics-upload | missing |
| `report/templates/daily_store_report/index.html` | `report/templates/daily_store_report/index.html` | daily-store-report | external_acceptance |
| `report/templates/day_close/cash_balance.html` | `report/templates/day_close/cash_balance.html` | finance-day-close | external_acceptance |
| `report/templates/day_close/index.html` | `report/templates/day_close/index.html` | finance-day-close | external_acceptance |
| `report/templates/day_close/logs.html` | `report/templates/day_close/logs.html` | finance-day-close | external_acceptance |
| `report/templates/export/index.html` | `report/templates/export/index.html` | report-exports | external_acceptance |
| `report/templates/orders/daily_tracker.html` | `report/templates/orders/daily_tracker.html` | operational-reports | external_acceptance |
| `report/templates/orders/hyperlocal_daily_report.html` | `report/templates/orders/hyperlocal_daily_report.html` | operational-reports | external_acceptance |
| `report/templates/orders/hyperlocal_data.html` | `report/templates/orders/hyperlocal_data.html` | operational-reports | external_acceptance |
| `report/templates/orders/hyperlocal_order_accept_report.html` | `report/templates/orders/hyperlocal_order_accept_report.html` | operational-reports | external_acceptance |
| `report/templates/orders/nps_data.html` | `report/templates/orders/nps_data.html` | operational-reports | external_acceptance |
| `report/templates/orders/orders_data.html` | `report/templates/orders/orders_data.html` | operational-reports | external_acceptance |
| `report/templates/orders/return_orders.html` | `report/templates/orders/return_orders.html` | operational-reports | external_acceptance |
| `report/templates/performance_report/cashier_performance.html` | `report/templates/performance_report/cashier_performance.html` | operational-reports | external_acceptance |
| `report/templates/performance_report/salesperson_performance.html` | `report/templates/performance_report/salesperson_performance.html` | operational-reports | external_acceptance |
| `report/templates/product/product_inventory.html` | `report/templates/product/product_inventory.html` | inventory-workbooks, catalog-read | external_acceptance |
| `report/templates/sales/index.html` | `report/templates/sales/index.html` | operational-reports | external_acceptance |
| `stores/templates/counters/index.html` | `stores/templates/counters/index.html` | counters | implementation_present |
| `stores/templates/stores/_form.html` | `stores/templates/stores/_form.html` | stores, store-images, location-codes, country-search | external_acceptance |
| `stores/templates/stores/create.html` | `stores/templates/stores/create.html` | stores, store-images, location-codes, country-search | external_acceptance |
| `stores/templates/stores/edit.html` | `stores/templates/stores/edit.html` | stores, store-images, location-codes, country-search | external_acceptance |
| `stores/templates/stores/index.html` | `stores/templates/stores/index.html` | stores, store-images, location-codes, country-search | external_acceptance |
| `stores/templates/stores/show.html` | `stores/templates/stores/show.html` | stores, store-images, location-codes, country-search | external_acceptance |
| `stores/templates/stores/slack_callback.html` | `stores/templates/stores/slack_callback.html` | store-slack-oauth | external_acceptance |
| `stores/templates/stores/storage/create.html` | `stores/templates/stores/storage/create.html` | storage | implementation_present |
| `stores/templates/stores/storage/edit.html` | `stores/templates/stores/storage/edit.html` | storage | implementation_present |
| `stores/templates/stores/storage/index.html` | `stores/templates/stores/storage/index.html` | storage | implementation_present |
| `stores/templates/stores/storage/show.html` | `stores/templates/stores/storage/show.html` | storage | implementation_present |
| `users/templates/admin/includes/footer.html` | `users/templates/admin/includes/footer.html` | shared-shell | implementation_present |
| `users/templates/admin/includes/header.html` | `users/templates/admin/includes/header.html` | shared-shell | implementation_present |
| `users/templates/admin/includes/navbar.html` | `users/templates/admin/includes/navbar.html` | shared-shell | implementation_present |
| `users/templates/admin/includes/sidebar.html` | `users/templates/admin/includes/sidebar.html` | shared-shell | implementation_present |
| `users/templates/admin/includes/whatsnew.html` | `users/templates/admin/includes/whatsnew.html` | shared-shell | implementation_present |
| `users/templates/admin/layouts/base.html` | `users/templates/admin/layouts/base.html` | shared-shell | implementation_present |
| `users/templates/admin/layouts/base_create_order.html` | `users/templates/admin/layouts/base_create_order.html` | shared-shell | implementation_present |
| `users/templates/admin/layouts/base_no_sidebar_navbar.html` | `users/templates/admin/layouts/base_no_sidebar_navbar.html` | shared-shell | implementation_present |
| `users/templates/auth/auth_qr.html` | `users/templates/auth/auth_qr.html` | device-signin | external_acceptance |
| `users/templates/auth/create.html` | `users/templates/auth/create.html` | operators | implementation_present |
| `users/templates/auth/edit.html` | `users/templates/auth/edit.html` | operators | implementation_present |
| `users/templates/auth/index.html` | `users/templates/auth/index.html` | operators | implementation_present |
| `users/templates/auth/login.html` | `users/templates/auth/login.html` | identity | external_acceptance |
| `users/templates/auth/profile.html` | `users/templates/auth/profile.html` | self-profile | external_acceptance |

### websockets

| Source | Surface | Families | Implementation disposition |
| --- | --- | --- | --- |
| `notification/routing.py:6` | `ws/notification/(?P<room_name>\w+)/$` | notifications | external_acceptance |

### administration

| Source | Surface | Families | Implementation disposition |
| --- | --- | --- | --- |
| `stores/admin.py:6` | `Store` | stores, store-images, support, ecommerce-inventory-sync, inherited-administration-history, inherited-model-add-forms | external_acceptance |
| `users/admin.py:20` | `User, UserAdmin` | operators, operator-administrative-profile, operator-mfa, model-administration-access, inherited-administration-history, inherited-model-add-forms | external_acceptance |

## Reproducibility and limits

Regenerate with `python3 tools/parity/build_source_surface_map.py`; validate saved outputs without writing using `--check`. The generator verifies pinned source hashes, exact source ID/count coverage, explicit family membership, evidence-path existence and stable file inputs during generation. It only writes the two new map artifacts. It does not run tests, builds, servers, providers, DDL or source jobs and never modifies application code, source siblings or the release coverage ledger.

Source definitions/rendered templates are resolved from pinned Python AST/imports where possible. Framework/dynamic imports remain labeled explicitly. Test references identify evidence scope; they are not fresh test receipts. Implementation hashes capture this review snapshot while other agents may continue their separately owned work; regenerate after those slices land.
