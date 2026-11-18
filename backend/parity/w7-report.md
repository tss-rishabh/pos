# W7: offline cash removal and ORM/production schema alignment

Branch `w7/orm-align` from `324d62d`. Legacy citations are `backend-pos-web@78d5b63`.
Production DDL is `tests/golden/schema/production-schema.json`. Nothing here was
run against production; every MySQL check used an isolated loopback MySQL 8.4
started with an empty `sql_mode`.

Commits:

| Commit | Scope |
|---|---|
| `5461303` | Delete the backend offline cash module; legacy-only report and finance cash |
| `ba05caf` | Delete the IndexedDB offline cash and fast-cash frontend |
| `68e2e19` | Parity docs and regenerated source surface map |
| `70cf32c` | Align `src/db/legacy-schema.ts` with production |
| `fc4a333` | Align module-local production tables; adapt global vouchers |

## 1. What was deleted (Task 1)

### Backend

- `src/modules/checkout/offline-cash/**` (19 files), `src/modules/finance/offline-cash.ts`,
  `src/modules/daily-report-offline.ts`.
- Migrations `0011_offline_cash.sql`, `0012_offline_cash_receipt_identity.sql`,
  `0013_offline_cash_import_proof.sql` and their `migrationPaths` entries. They created only
  `pos_rewrite_offline_cash_*` tables.
- `registerOfflineCash` and the `offlineCash` override in `checkout/routes.ts` (8 routes;
  the route-count test is now 91).
- Offline-cash guards that legacy does not have: `rejectOfflineCashSettlement` in the
  payments repository, `ORDER_ALREADY_SETTLED_OFFLINE` in cancellations, the
  offline-cash part of the payment-reversal immutable-sale check (the pending
  cancellation check stays), and `ORDER_COPY_OFFLINE_CASH_COLLECTED` in order copy.
  The `readOnly` flag of order copy existed only for that guard and was removed.
- The shared `amount_to_be_refunded_log` projection that refund allocation,
  cancellations and payment reversals imported from `offline-cash/source-ledger.ts` moved
  unchanged to `checkout/refund-audit.ts`. `flag_history` and
  `order_cancel_message_mapping` projections were used only by the offline-cash writer.
- `offline-cash-import` inventory synchronization reason.
- Offline-cash env keys in `.env.example`, the offline-cash section of `deployment.md`,
  verifier stages `source-pricing-fixture-typecheck`, `cash-manager-fixture-typecheck`,
  `owner-cash-import-fixture-typecheck`, `fast-cash-browser-fixture-typecheck`,
  `cash-manager-browser-tests`, `performance-production-fixture-typecheck`.
- Tests: `tests/checkout/offline-cash{,-gateway,-mysql.integration,-reference,-source-pricing}.test.ts`,
  `offline-cash-fixtures.ts`, `tests/finance/offline-cash.mysql.integration.test.ts`, goldens
  `checkout/offline-cash-reference.json` and `offline-cash-source-pricing.snapshot.json`,
  `tools/checkout/source-pricing.tsconfig.json`; offline-cash cases in the order-copy,
  payment-reversal and checkout route tests; offline-cash migrations in shared fixtures.

Reports and finance now keep only legacy behaviour (legacy has no offline-cash concept):

- Current-day daily store sales runs the source `report/report_queries.py` SQL with only the
  payment-correction changes. `paymentCorrectionDailyStoreTemplate` now patches the source
  SQL directly, so its output equals the previous output with no imported receipts.
  `pending_offline_orders` and `pendingOrderCount` are removed from the API and UI.
- Collection snapshot and current cash ledger use the source `SUM(offline_payment)` and
  `COUNT(*)` (`report/day_close_queries.py:4`) plus payment corrections. The
  late-offline-cash ledger note and `lateOfflineCash` are removed, also from the cash-ledger
  payment-correction baseline hash.
- Warehouse contracts move to `pos-daily-store-sales-v2` (no `pending_offline_orders`
  column in the row hash) and `pos-cash-collections-v2` (no `late_offline_cash`), so a v1
  publication fails closed. Env var and column names are unchanged
  (`tools/reports/daily-warehouse-contract.json`, `deployment.md`).

### Frontend

- `src/offline/cash/**`, `src/offline/fast-cash/**`, `src/pages/checkout/offline-cash/**`,
  `FastCashCheckout.tsx`, `src/offline/shell-ready.ts` (the retired offline-cash shell guard).
- Counter: `CashTools`, `cashCompleted`, the cash-open state and the offline-cash price note.
  `CheckoutReview`: the fast-cash state, panel and shortcut branches.
- Draft queue, review snapshot, clear and conflict resolution no longer read
  `offlineCashReceipts`.
- Dexie: version 11 declares `offlineCashDevices`, `offlineCashAuthorizations`,
  `offlineCashReceipts`, `offlineCashSync`, `fastCashCommands` and `fastCashOwners` as `null`,
  which is how Dexie drops a table. Versions 5, 7 and 9 keep their declarations so every
  historical schema upgrades in order; the version 9 upgrade function only rewrote
  `offlineCashSync` and was removed. The barcode upgrade test now checks a version 9
  database upgrades to 11, keeps drafts and drops `offlineCashReceipts`.
- Performance capture keeps its local phase recording. `freezePerformance`,
  `bindPaidPerformance` and `deferUnpaidPerformance` were only reachable from fast cash and
  were removed with it.
- Tests: `tests/offline-cash*.test.ts`, `tests/fast-cash*`, `tests/checkout-manager/**`,
  `tests/checkout-order-import/**`, `tests/performance-runner/tsconfig.e2e.json`,
  `e2e/checkout/{offline-cash,fast-cash,checkout-performance}.spec.ts`. The
  `performance-storage` test now covers the surviving capture functions directly.
  `offline-shell.test.ts` and `offline.test.ts` needed no change.

Kept intact: `frontend/electron/offline/**`, `frontend/src/offline/billing/**`,
`frontend/src/pages/offline-billing/**`, `backend/src/modules/offline-sync/**` (only a
nullable `invoice` type changed there, see section 3).

Docs: `parity/offline-cash.md` and `parity/cash-manager.md` deleted; `fast-cash.md`,
`daily-report-offline.md`, `checkout.md`, `finance.md` and `tests/golden/INVENTORY.md`
updated; `source-surface-families.json` updated and the surface map regenerated (the
`fast-cash` family is now `partial`). Historical receipts under `backend/tools/**` and
`backend/evidence/**` were not touched. `parity/bigquery-deployment/plan.json` was already
stale (W2) and was not regenerated.

## 2. ORM mismatches (Task 2)

| | Count |
|---|---|
| Before (W2 pin) | 432 (394 in `legacy-schema.ts`) |
| Removed with offline cash | 2 (`offline-cash/legacy-import-schema.ts`) |
| After | **0** — `tests/orm-known-mismatches.json` is empty |

**Remaining mismatches: none.** The comparison in `tests/orm-metadata.test.ts` was not
changed. It already treats `boolean` as `tinyint(1)` only. A declaration without a display
width (`tinyint()`) matches `tinyint(1)` through the test's existing rule for unsized
declarations; 12 former `int`/`smallint` columns use that.

## 3. API output representation

### Kept identical by mapping (`src/db/legacy-columns.ts`)

Each builder declares the production SQL type and reuses the exact `mapFromDriverValue`
of the builder it replaced, so read values and JSON output are unchanged.

| Builder | Production type | Runtime value (unchanged) | Columns |
|---|---|---|---|
| `intBigint` (real builder, supports `.autoincrement()`) | `int` | `bigint` via `BigInt()` | `add_desc.id`, `countries.id`, `coupons.id`, `courier_companies.id`, `hyperlocal_order_log.id`, `hyperlocal_rejection_reasons.id`, `order_platform.id`, `order_status.id`, `payment_method.id`, `payment_status.id`, `pos_machines.id`, `pos_paytm_machines.id`, `pos_terminal_payment_modes.id`, `pos_tutorial.id`, `pricelist_meta.id`, `tss_settings.id`, `orders.{courier,order_status,payment_method,payment_status}`, `has_products.order_platform_id`, `order_stores.counter_id`, `express_line_item.{order_id,has_product_id}`, `store_counters.store_id`, `store_storages.store_id` |
| `tinyintBoolean` | `tinyint` | `boolean` (`=== 1`, as `boolean()`) | `product_store.{is_avail,is_del}`, `pos_csv_upload.is_imported`, `pos_terminal_transactions.is_active`, `pos_paytm_transactions.is_active`, `has_products.is_notified_for_return`, `order_stores.{is_manually_paid,is_offline_order,is_shopify_order}`, `extend_applicability_for_return_exchange.is_active`, `report_exports.is_completed`, `tss_settings.status`, `stores.is_active`, `store_storages.is_active`, `store_counters.is_active` |
| `doubleString` | `double` | string, `String(number)` as `decimal()` did | `order_stores.{offline_payment,offline_payment_recieved,online_payment,online_other_payment}`, `pos_terminal_transactions.{amount,cash_amount,cash_recieved,total_amount}`, `pos_paytm_transactions.{amount,cash_amount,cash_recieved,total_amount}` |
| `floatString` | `float` | string | `pricelist.price` |
| `varcharInt` | `varchar(45)` | number, as `int()` (Django `IntegerField`, `core/models.py:450`) | `store_salesperson.is_active` |

Other type changes with an identical runtime value: `int`/`smallint` → `tinyint`
(same `Number` mapping), `datetime` → `timestamp` in string mode (passthrough), varchar
length/`text`/`longtext`/`char` changes, `decimal` precision (`products.price`,
`spl_price` 10,2 → 8,2; the driver returns the stored string), `stores.latitude/longitude`
`decimal` → `varchar` (both strings), `gift_vouchers.voucher_initial_value` `int` → `double`
(both pass the driver number through), `tss_money_history.order_id` (return report)
`int` → `bigint` number mode (both `Number()`), `has_products.pre_gst_amt` `double` →
`decimal` number mode (its only reader already applied `Number()`).
`hyperlocal_order_log.rto_recieved` (`text` → `tinyint`) has no reader.

ENUM columns now use `mysqlEnum` with the exact production members and order. Writes of
values that may not be members go through `storedEnumValue`, which writes `''` for a
non-member, the value MySQL stores under the empty `sql_mode`: `has_products.status`
(order_status names), `gift_voucher_history.platform` (`'GV_ADD'`), cancellation
`tss_point_history.platform` (`'FIRST_ORDER_RETURN_BONUS'`). Those columns are typed
`… | ''`. ENUM member lists used at runtime are in `src/db/legacy-enums.ts`.

### Changed output (aligned with legacy or fail-closed)

| Place | Before | Now | Legacy reference |
|---|---|---|---|
| Daily store sales API/UI | `pending_offline_orders`, `pendingOrderCount`, offline cash added | removed | `report/report_queries.py` |
| Collection snapshot / cash ledger | offline receipts added, late-offline note | source sums only | `report/day_close_queries.py:4` |
| Credit note number for a NULL `stores.location_code` | `null25CN…` | `None25CN…` | `helpers/helpers.py:2205,2299` |
| Inbound return `order_location` for NULL code | `null` | `null` (now typed) | `helpers/helpers.py:1898` |
| OTP mail, PG-discount mail, RTO/packing audit comment, `get_full_name`-style names with NULL `first_name`/`last_name` | `null` text | `None` | `core/tasks.py:110,254,261`, `order/views.py:4088,4149` |
| Profile view `firstName`/`lastName` when NULL | JSON `null` (frontend parse failed) | `'None'` | `users/templates/auth/profile.html:86,99` |
| Documentation description when NULL | sanitizer crash | `'None'` | `core/templates/documentation/_detail.html:16` |
| Transaction ID with NULL `order_ref_no` and active Paytm | `TypeError` | explicit error / `searchDataInvalid` | `helpers/helpers.py:730` |
| Order list/detail `reference`, detail line `status` | JSON `null`, frontend parse failed | JSON `null`, frontend accepts it | — |
| Legacy export `canDownload` with NULL `is_completed` | `null` | `false` | — |
| Global voucher rows | `NULL` dates, `'GV_ADD'` (needed candidate DDL) | zero dates, `''` | `core/views.py` `AjaxGiftVoucherModuleView` |
| Hyperlocal acceptance filter | `action='accepted'` | `action='ACCEPTED'` (same rows, `latin1_swedish_ci`) | `report/views.py:1690` |

Other null handling: NULL `orders.next_location_ids` means no backup/next stores
(`order/views.py:579,3777`); NULL `pos_tutorial` media lists are invalid metadata
(`ast.literal_eval(None)` raises, `core/views.py:2512-2514`); NULL `sub_reasons.cat_id`
matches no category; NULL `tss_money_history` amounts never prove a hyperlocal refund;
`express_line_item` rows without `order_id` are skipped by maintenance (they could never be
locked by order).

MySQL fixtures that build tables from Drizzle definitions now get production types, so
raw-SQL expectations changed: `order_stores` payments are DOUBLE numbers,
`store_salesperson.is_active` is a varchar string, unset nullable columns are `NULL`, and
a fictional `has_products.status='CONFIRMED'` fixture value became `PLACED`.

## 4. Checks

| Check | Result |
|---|---|
| backend `npx tsc --noEmit -p .` | pass |
| backend `npx eslint .` | pass |
| backend `npx vitest run tests/orm-metadata.test.ts` | pass, 0 known mismatches |
| backend tests typecheck (temporary `src`+`tests` tsconfig) | 38 errors, identical to the `324d62d` baseline |
| backend full `vitest` with loopback MySQL | see below |
| frontend `npx tsc --noEmit -p .`, `npx eslint .` | pass |
| frontend `vitest --maxWorkers=2` | 56 files / 269 tests pass, 23 files skipped (browser env) |

Full backend run (232 files, MySQL-backed suites enabled): 1532 tests pass, 30 skipped,
5 fail plus 2 suites fail at setup. All of them also fail at `324d62d` in the same
environment: four `tests/checkout/mysql.integration.test.ts`
cases (exchange email count, three discount-approval check-in cases), the
`customer-history` Latin1 case, and `customer-otp` / `special-permission-history`
(their fixtures need template names this environment did not provide). Playwright e2e and
browser fixtures were not run.

## 5. NEEDS USER DECISION

1. **Legacy sessions are strict.** `POSAdmin/settings.py:183,203,222` set
   `init_command: SET sql_mode='STRICT_TRANS_TABLES'` on every legacy connection, while
   AGENTS.md assumes legacy writes run under the empty server `sql_mode`. Under the legacy
   session, `'GV_ADD'` and points `'FIRST_ORDER_RETURN_BONUS'` inserts fail instead of
   storing `''`, and `AjaxGiftVoucherModuleView`'s `coupons` insert without `end_date`
   fails (error 1364), so legacy global-voucher issuance cannot succeed against production
   DDL. W7 followed AGENTS.md (explicit `''` and zero dates, and the rewrite pool inherits the
   server mode). Confirm this, or choose to reproduce the legacy failure.
2. **Initial courier log.** `legacy-fulfillment/lifecycle/source-log.ts` inserts
   `hyperlocal_order_log` with `delivery_exception_date = NULL`, which production
   (`NOT NULL`, no default) rejects. It stays behind its fail-closed guard
   (`LOCAL_DELIVERY_LOG_SCHEMA_UNAVAILABLE`), and the insert writes `sql\`NULL\`` explicitly.
   Legacy POS never inserts this table. The ledger
   (`table-disposition.md`, Unregistered SQL A#2) says to remove the insert or write it as the
   owning service does; the candidate `compatibility/001_unset_exception_date.sql` is still in
   the tree. Choose: remove the insert, or write the zero date and drop the guard.
3. **Fast checkout.** Deleting `FastCashCheckout`/`offline/fast-cash` removed the only UI for
   legacy fast checkout (`AjaxFastCheckoutView`, `order/urls.py:54`). The `F` shortcut still
   maps to `fast-cash` but has no target, the backend `settlement-note` resource has no
   client, and `performanceCommands` (legacy `order_stores.performance`, `order/views.py:2798`)
   have no producer. Decide whether fast checkout and performance timing are rebuilt on the
   online flow.
4. **Warehouse contracts.** The daily-sales and cash-collection publishers must emit the v2
   literals and drop the offline columns. Env names (`*_OFFLINE_CONTRACT`) and the contract
   column names were kept. Confirm, or rename them together with the deployment plan.
5. **Existing IndexedDB data.** Dexie version 11 deletes any unsynced offline-cash receipts
   and fast-cash intents on a device that still holds them. This is safe only if no
   installation used the retired IndexedDB offline cash.
