# Phase C — Legacy background jobs and the Redis job-queue design

Status: read-only inventory and design. Changes no code.

Citation conventions:
- **Legacy** paths are relative to the pinned export of `backend-pos-web@78d5b63`.
- **Rewrite** paths are relative to `backend/` on `refactor/single-stack-schema-freeze` @ `324d62d`
  (the W2 merge that removed screening, CSV order import, SSO and the compatibility tree).
- **Production DDL** is `tests/golden/schema/production-schema.json`.
- **UNKNOWN** marks facts that these sources cannot settle.

---

## 1. Legacy runtime topology

| Process | Command | Citation |
|---|---|---|
| Web | `manage.py runserver 0.0.0.0:8000 --noreload` under `opentelemetry-instrument` (Django dev server, TZ `Asia/Kolkata`) | `Dockerfile:8,80` |
| Celery worker | `celery -A POSAdmin worker -Q core,store,order_create,export_queue,report_queue,sales_queue,order --concurrency=2` | `Dockerfile.celery:11,64` |
| Flower | `celery -A POSAdmin flower --port=8002` (basic auth configured inline; credentials not reproduced) | `Dockerfile.flower:64` |
| **Celery beat** | **none.** No `beat_schedule`, `CELERY_BEAT_*`, `django_celery_beat`, `periodic_task` or `crontab` anywhere in the tree | grep of the whole export |
| **Management commands / cron** | **none.** No `management/commands/` directory; no cron files | `find` of the whole export |

Celery configuration (`POSAdmin/celery.py:1-8`, `POSAdmin/settings.py:417-431`):
- `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND` from env — **broker transport UNKNOWN** (the
  `visibility_timeout` transport option, 172 800 s = 48 h, applies to the Redis and SQS transports).
- Routes: `core.tasks.*` → `core`, `stores.tasks.*` → `store`, `report.tasks.*` → `report_queue`,
  `order.tasks.*` → `order`. Tasks in other modules (`order.views`, `report.datatables.*`) are routed only by an
  explicit `queue=` at the call site. Queues `order_create`, `export_queue`, `sales_queue` exist only through those call
  sites and `Dockerfile.celery:64`; the ledger's queue list (`table-disposition.md`, "Proposed Redis conventions")
  names only four queues and misses these three.
- No task sets `autoretry_for`, `max_retries`, `retry`, `acks_late` or `rate_limit` (grep). Celery 5.3 defaults apply:
  **ack on receipt (`acks_late=False`), no retries** → **at-most-once** for immediate tasks. Tasks published with
  `countdown` are held unacknowledged by the worker until due; with the Redis transport they are redelivered only after
  `visibility_timeout` (48 h) if the worker dies first (UNKNOWN for SQS).
- Default queue `celery` is **not consumed** (`Dockerfile.celery:64`). Every live call site either matches a route or
  passes `queue=`, so no live task lands there (checked below).

---

## 2. Inventory

32 Celery tasks were found: `core/tasks.py` 14, `stores/tasks.py` 1, `order/tasks.py` 1, `report/tasks.py` 5,
`order/views.py` 4, `report/datatables/*.py` 7. Plus 5 thread / event-loop background mechanisms.

"Sync" means the task function is called directly in the request thread, so it is **not** a background job in
practice even though it is decorated.

### 2.1 `core/tasks.py` (queue `core` when enqueued)

| # | Task | Trigger (caller) | Mode | Args | Side effects | Retries |
|---|---|---|---|---|---|---|
| C1 | `parse_csv_product_store` `:28-37` | `ProductsStoreBulkUploadView.post` `core/views.py:139` | `.delay` | `upload_id, user_id, role_id` | reads uploaded CSV; `product_store` bulk insert; `pos_product_inventory_logs` via `sync_pos_inventory`; `pos_csv_upload.is_imported=1, failed_data` ; HTTP product sync (`helpers/task_helpers.py:64-172`) | none |
| C2 | `parse_csv_product_stock` `:39-48` | `ProductsStockBulkUploadView.post` `core/views.py:393` | `.delay` | same | `product_store.stock/is_avail/is_del`, `hold_stock_store`, inventory logs, `pos_csv_upload`, product sync (`helpers/task_helpers.py:175-350`) | none |
| C3 | `parse_csv_offline_order_punchin` `:50-59` | caller commented out `core/views.py:1003` | **dormant** | `upload_id, user_id, role_id` | order creation via API-v2 + `send_sms.delay` (`helpers/task_helpers.py:353-625`) | none |
| C4 | `parse_csv_shopify_order_punchin` `:61-68` | caller commented out `core/views.py:1093` | **dormant** | `upload_id, user_id, store_id` | as C3 | none |
| C5 | `send_sms` `:70-81` | `AjaxOrderView.post` `order/views.py:2829`; `AjaxFastCheckoutView.place_order` `order/views.py:3336`; dormant C3 `helpers/task_helpers.py:572` | `.delay` | `order_id` | `POST {MAIN_API_V2_URL or API_V2_URL}omnichannel-sms {"order_id"}` (no timeout); logs non-200 | none |
| C6 | `send_login_otp` `:83-144` | `CustomLoginView.post` `users/views.py:133`; `AjaxSendLoginOtpView.post` `users/views.py:281` | **sync** | `user_id, resend=False` | Redis `login_otp:{uid}`; Gupshup SMS / Netcore email; WhatsApp thread on resend (see auth spec §1.4-1.5) | none |
| C7 | `accept_order` `:146-156` | callers commented `order/views.py:3527` | **dormant** | `order_id, email` | `POST MJML_HOST api/v2/mailr/order/accepted/` | none |
| C8 | `reject_order` `:158-168` | callers commented `order/views.py:3658` | **dormant** | `order_id, email` | `POST … /order/rejected/` | none |
| C9 | `new_order_create_communication` `:170-179` | inside task O3 `order/views.py:4011` | `.delay` | `order_id` (new online order) | `POST MJML_HOST api/v2/mailr/hyper_local/order_new/` | none |
| C10 | `sync_ecom_inventory` `:181-199` | `AjaxEcomSettingUpdate.run_sync` `core/views.py:2166-2167` (after `ecom_delivery_{store}` Redis cooldown `core/views.py:2108-2112`) | `.delay` | `store_id` | per `product_store` row with `stock > ecom_threshold`: `CALL pos_stock_syncer_bk(store, product, stock, 0, 0, "Updated by System")` (string-built SQL); then `GET MAIN_API_V2_URL syncproduct` (errors ignored) | none; exceptions logged |
| C11 | `generate_and_upload_gift_card` `:208-223` | `AjaxGenerateGiftCardView.post` `core/views.py:2203` | **sync** | `id, size, user_phone, email` | `Helpers.generate_gift_card` + `upload_save_data` (zip password from phone digits + collection no., `helpers/helpers.py:1315-1350`), email attachment; `gift_card_collection.filename, is_completed=1, message` | none |
| C12 | `push_vinc_order_for_all` `:225-229` | `return_processed` when Vinculum return fails and an `order_stores` row exists `order/libs/calculations.py:164-167` | `.delay` | `order_id` | `POST {BACKEND_SYNC_API_BASE_URL}/store-order/status {"orderId","has_product_ids","platform":"PACK"}` timeout 10 (`helpers/helpers.py:1133-1158`) | none |
| C13 | `send_pg_disc_otp` `:231-268` | `AjaxPGDiscOTPSend.post` `order/views.py:4626` | **sync** | `user_id, tab_id, store_id, counter_id, pg_discount, user_name, store_name, total_amount, user_id_list` | reads/deletes then sets Redis `{user}_{store}_{counter}_{tab}` = JSON `{otp: [manager_id, pg_discount]}` EX `PG_DISC_OTP_EX_VALUE`; Netcore email per manager (`pos_user.role=3` or listed `contact_email`s) | none |
| C14 | `pg_disc_otp_applied_email` `:270-324` | `AjaxOrderView.post` `order/views.py:2772,2775`; `AjaxFastCheckoutView.post` `order/views.py:3257,3259` | **sync** | `order_id, pg_disc_comment, pg_discount_amount, pg_discount_otp, redis_user_id, user_id, store_id, counter_id` | `INSERT INTO tss.store_pg_disc_addons …` (string-built SQL); Netcore email | none |

### 2.2 `stores/tasks.py` (queue `store`)

| # | Task | Trigger | Mode | Side effects |
|---|---|---|---|---|
| S1 | `create_random_user_accounts_new` `stores/tasks.py:10-18` | callers commented `stores/views.py:227`, `core/views.py:945` | **dormant** | prints only (`create_user` commented) |

### 2.3 `order/tasks.py` (queue `order`)

| # | Task | Trigger | Mode | Args | Side effects | Retries / locking |
|---|---|---|---|---|---|---|
| O1 | `auto_reject_timed_out_for_store` `order/tasks.py:149-221` | **page views**: `HyperlocalProgressView.get` `order/views.py:4919`, `AjaxHyperlocalProgressDataView.get` `:4952`, `AjaxHyperlocalProgressContentView.get` `:5296` — with the viewer's checked-in store | `.delay` | `store_id` | Redis lock `express_reject_lock:{store}` `SET NX EX HL_REJECT_LOCK_TTL_SECONDS` (300), DEL in `finally`; `express_line_item` status PENDING→REJECTED/TIMED_OUT, ACCEPTED→PACKED, TIMED_OUT→REJECTED; `express_order_status_log` rows; `POST MAIN_API_V2_URL express-to-warehouse-order` (timeout 10); `POST BACKEND_SYNC_API_BASE_URL/order/status` PACK; pre-order concurrency sync thread; Slack | none; lock-skip if held; rejection API for TIMED_OUT→REJECTED deferred with `transaction.on_commit` `:217` |

There is **no timer**: expiry processing happens only when someone opens a hyperlocal progress page for that store.

### 2.4 Tasks defined in `order/views.py` (explicit queues)

| # | Task | Trigger | Mode / queue | Args | Side effects |
|---|---|---|---|---|---|
| O2 | `auto_hl_order_transfer` `order/views.py:3844-3935` | `AutoHlOrderView.post` (service API, `APPID/APPKEY`) `:3724` with `countdown` = cut-off buffer or `ORDER_CREATION_BUFFER_TIME_IN_SEC` (+ advance-order buffer); **sync** from `AjaxPassOrderView.post` `:4265` | `apply_async` `order_create`, countdown | `order_id[, user, reason, is_auto, reason_dropdown]` | guards on `hyperlocal_order_log.action`; `orders.is_transfer=1`; notifications (O5 path, sync); hold/unhold `hold_stock_store` + `pos_hold_stock_logs`; `order_addons.order_transferred_timestamp`; `pos_transaction_logs`; enqueues O3 (countdown or 0); Slack |
| O3 | `auto_hl_order_to_online` `:3937-4031` | from O2 `:3915,3924,3927` (`order_create`, countdown); **sync** from `AjaxHlOrderView.create` `:3564` and `AJaxConvertOnlineView.convert_online` `:3835` | `apply_async` `order_create` | `order_id, store_id, platform, next_ids, reason, staff_user, reason_dropdown` | guards on `hyperlocal_order_log`; online-eligibility check; cancel/refund via API-v2 `cancel-hl-order`; Freshdesk/OneDirect ticket; unhold stock; `Helpers.create_online_order` (API-v2); `orders.hl_parent_order_id` guard; enqueues C9; comments/logs |
| O4 | `auto_hl_order_create` `:3838-3842` | caller commented `:3727` | **dormant** | `order_id, store_id` | `AjaxHlOrderView.create` |
| O5 | `advance_order_notification` `:4481-4483` | `AutoHlOrderView.post` `:3696` (`order_create`, countdown = advance-order buffer); `AjaxExpressOrderNotifyView.post` `:5279` (`order`, kwargs `send_to_common=False`, per store id) | `apply_async` | `title, order_id, store_id, is_slack, is_new_order[, send_to_common]` | `create_order_notification_sync` (`helpers/notification_helpers.py:40-57`): Slack, `pos_notifications` insert, `pos_user_notifications` bulk insert for users in `check_in_list_{store}`, Channels `group_send("notification_order")` over Redis |

### 2.5 `report/tasks.py` (queue `report_queue`) — whole family **dormant**

The only caller, `AjaxInventoryReportView.do_return_export` (`report/datatables/inventory_datatable.py:242-257`), is reachable only
through a URL that is commented out (`report/urls.py:26`).

| # | Task | Notes |
|---|---|---|
| R1 | `process_export_master(request_data, report_id)` `report/tasks.py:24-81` | per store: product ids from the read replica, chunks of 50 000, `chord(group(R2…), R3)`, then a final `chord(…, R5)` |
| R2 | `generate_store_excel_chunk` `:86-131` | writes `/tmp/temp_exports/store_{id}_{n}.xlsx` |
| R3 | `merge_store_chunks` `:138-160` | merges per store |
| R4 | `debug_print_result` `:133-135` | unused |
| R5 | `merge_all_stores_and_upload` `:163-247` | S3 upload `uploads/reports/inventory/…xlsx`; `report_exports` completed/failed |

### 2.6 Export tasks in `report/datatables/*.py` (`@app.task(bind=True)` on view methods)

Common shape: the task creates the `report_exports` row itself (`export_status='Processing'`), runs raw SQL on
`READ_DB_ALIAS` (`POSAdmin/settings.py:227`), builds a CSV with `Helpers.create_and_upload_csv` (`helpers/helpers.py:2130`),
uploads to S3, and updates `report_exports` (`Helpers.create_update_report_export`, `helpers/helpers.py:2084`).
The HTTP response returns before the row exists, so a lost task leaves **no row at all**.

| # | Task (Celery name = module + function) | Trigger | Queue | `report_type` / statuses written |
|---|---|---|---|---|
| E1 | `return_orders_datatable.do_return_export` `:62-156` | `AjaxReturnOrderListView.handle_export` `:36` (`is_export`) | `export_queue` | `RETURN`; `Processing` → `COMPLETED` (no failure branch) |
| E2 | `return_orders_datatable.do_order_export` `:327-509` | `AjaxOrdersDataListView.handle_export` `:298` | `export_queue` | `ORDER`; `Processing` → `COMPLETED` |
| E3 | `cash_balance_datatable.do_cash_balance_export` `:82-135` | `AjaxCashBalanceView.handle_export` `:68-75` | `export_queue` | `CASH_BALANCE`; `Processing` → `Completed` / `FAILED` |
| E4 | `sales_data.do_sales_export` `:65-145` | `AjaxSalesDataView.handle_export` `:37` | `sales_queue` | **`RETURN`** (`:84`, mislabelled); `Processing` → `COMPLETED` (`:85,137`) |
| E5 | `day_close_datatable.do_day_close_export` `:215-317` | `AjaxDayCloseLogsView.handle_export` `:111-120` | `export_queue` | `DAY_CLOSE`; `Processing` → `Completed` / `FAILED` |
| E6 | `hyperlocal_daily_datatable.do_hyperlocal_daily_export` `:39-173` | `AjaxHyperlocalDailyExportView.post` `:30-31` (`report/urls.py:88`) | `export_queue` | `HYPERLOCAL_DAILY`; `Processing` → `COMPLETED` / `FAILED` |
| E7 | `inventory_datatable.do_return_export` (class `_old`) `:59-138` | `AjaxInventoryReportView_old.handle_export` `:33`; URL commented `report/urls.py:26` | `export_queue` | **dormant**; `INEVNTORY` (typo) |

Status casing differs per export (`COMPLETED` vs `Completed`); the rewrite must write the same string per report type.

### 2.7 Threads and event-loop background work (not Celery)

| # | Mechanism | Trigger | Work | Delivery |
|---|---|---|---|---|
| T1 | `threading.Thread(daemon)` `users/login_otp.py:136-141` | login lockout `users/login_otp.py:179` | Slack lockout alert | at-most-once; lost on process exit |
| T2 | `Helpers.spawn_whatsapp_otp` `helpers/helpers.py:1591-1596` | login OTP resend `core/tasks.py:136-142` | Gupshup WhatsApp, Slack on failure | at-most-once |
| T3 | `Helpers.spawn_whatsapp_otp_fallback` `helpers/helpers.py:1556-1588` | customer registration `AjaxUserRegisterView` `order/views.py:2495` | sleep `WHATSAPP_OTP_FALLBACK_DELAY_TIME` (20 s), then send WhatsApp only if Redis key `{mobile}` still holds the same OTP | at-most-once |
| T4 | `Helpers.express_concurrency_sync` thread `helpers/helpers.py:1616-1670` | `order/tasks.py:80`; `AjaxExpressLineItemPackView` `order/views.py:4686`; `AjaxExpressLineItemsBulkActionView` `:5012`; `AjaxExpressOrderPackAllView` `:5064` | `POST PREORDER_URL/express-delivery/concurrency-sync` with signed deltas, Bearer `PREORDER_INTERNAL_KEY`, timeout 10 | at-most-once |
| T5 | un-awaited `loop.create_task(order_notification(...))` `order/views.py:3701-3703` | `AutoHlOrderView.post`, non-advance orders with `is_notify` | same as O5, run on the request's event loop | at-most-once; **whether it always completes under `runserver` + `async_to_sync` is UNKNOWN** |

Not background (awaited in the same request): `order/views.py:4078-4083` and `:4138-4141`. Channels `group_send` runs
synchronously in a fresh event loop (`helpers/notification_helpers.py:16-29`).

### 2.8 Externally triggered jobs (HTTP endpoints, caller UNKNOWN)

These run synchronously inside an HTTP request authenticated by the `apikey` header (`REPORTS_API_KEY`,
`helpers/helpers.py:1713-1717`) and are `csrf_exempt`. Something outside this repository (an external scheduler) calls them;
**who calls them, and on what schedule, is UNKNOWN**.

`HyperlocalStoreStatusReport` `report/views.py:810-811`, `HyperlocalDeliveryReport` `:902-903`,
`HyperlocalCancellationReport` `:994-995`, `CrmTicketStatus` `:1077-1078`, `StoreHyperlocalRecord` `:1587-1588`,
`HyperlocalSlackReport` `:1721-1722`, `HyperlocalAvailabilityReport` `:1875-1876` (URLs `report/urls.py:40-45,84`).
Side effects: Slack posts (`helpers/helpers.py:1093`); `CrmTicketStatus` reads ticket state (UNKNOWN external).

---

## 3. Mapping to the rewrite (current implementation at `324d62d`)

Rewrite worker scripts (`package.json:15-24`): `worker:financial-outbox`, `worker:administration`,
`worker:gift-card-batches`, `worker:customer-contacts`, `worker:customer-otp`, `worker:security`,
`worker:documentation-media`, `worker:settings`, `worker:profile-media`, `worker:store-images`.
In-process timers inside the API server: fulfillment (`src/modules/fulfillment/worker.ts:235`, enabled by
`FULFILLMENT_WORKER_ENABLED`, `index.ts:171`), local delivery lifecycle (`src/modules/legacy-fulfillment/lifecycle/index.ts:240-300`,
`LEGACY_DELIVERY_WORKER_ENABLED`), whole-order status (`src/modules/legacy-order-status/background.ts:38`,
`index.ts:132`), report exports and scheduled reports (`src/modules/operational-reports/index.ts:193-195`,
`job-worker.ts:35`).

| Legacy | Rewrite today | Parity status | Target in the new design |
|---|---|---|---|
| C1, C2 CSV inventory import | `worker:administration` + `pos_rewrite_inventory_imports`/`_rows` (`src/modules/administration/worker-main.ts`) | diverges: per-row durable state, leased rows | job `core.tasks.parse_csv_product_store` / `…_stock` on queue `core`; progress in `pos_csv_upload` as legacy |
| C3, C4 order punch-in | removed by W2 (AGENTS.md revision) | matches (dormant in legacy) | none |
| C5 `send_sms` | `worker:financial-outbox` → `pos_rewrite_payment_outbox` kind `order-sms` (`src/modules/checkout/payments/outbox.ts:117-165`); sends **Gupshup SMS directly** (`src/modules/checkout/order-messages/service.ts:151`) | **diverges**: legacy calls API-v2 `omnichannel-sms` | job `core.tasks.send_sms` on `core`: `POST {API-v2}omnichannel-sms {"order_id"}` |
| C6 `send_login_otp` | inline in `src/auth/mfa.ts:141-190` + `src/auth/delivery.ts` | matches "sync" (deltas in auth spec §1.10) | stays inline |
| C7, C8 | none | matches (dormant) | none |
| C9 `new_order_create_communication` | `pos_rewrite_local_delivery_calls` via the in-process local-delivery worker (`src/modules/legacy-fulfillment/lifecycle/provider.ts`) | diverges in mechanism | job `core.tasks.new_order_create_communication` on `core`, enqueued by O3 |
| C10 `sync_ecom_inventory` | `worker:settings` + `pos_rewrite_settings_effects`, `pos_rewrite_ecommerce_inventory_syncs` (`src/modules/administration/settings-worker-main.ts`, `ecommerce-sync/service.ts`) | diverges: checkpointed rows | job `core.tasks.sync_ecom_inventory` on `core`; cooldown key `ecom_delivery_{store}` as legacy |
| C11 gift-card generation | `worker:gift-card-batches` + `pos_rewrite_gift_card_batch_jobs` | **diverges: legacy is synchronous** | inline (see J3), derived zip password per AGENTS.md |
| C12 `push_vinc_order_for_all` | `pos_rewrite_return_repair_obligations` + in-process whole-order-status worker (`src/modules/legacy-order-status/*`) | diverges: durable obligation, manager recovery | job `core.tasks.push_vinc_order_for_all` on `core` |
| C13, C14 PG-discount OTP / applied mail | `worker:financial-outbox` → `pos_rewrite_discount_deliveries` (`src/modules/checkout/discounts/delivery.ts`) | **diverges: legacy is synchronous** | inline in the request; `store_pg_disc_addons` written synchronously with bound values |
| S1 | none | — | none |
| O1 auto-reject | in-process fulfillment worker on a 1 s timer scanning stores (`src/modules/fulfillment/worker.ts:35-240`, `maintenance.ts:29-110`); effects via `pos_rewrite_fulfillment_effects` (`outbox.ts:28-33`) | **diverges: legacy runs only on HL page views** (see J2) | job `order.tasks.auto_reject_timed_out_for_store` on `order`, enqueued by the 3 page endpoints; lock key `express_reject_lock:{store}` reused |
| O2, O3, O5 delayed HL jobs | `pos_rewrite_local_delivery_jobs` (ledger → Redis) + in-process local-delivery worker | diverges in mechanism | delayed jobs `order.views.auto_hl_order_transfer`, `…auto_hl_order_to_online`, `…advance_order_notification` on `order_create` / `order` |
| O4 | none | — | none |
| R1–R5 inventory workbook | rewrite has export kind `current-inventory-workbook` (`src/modules/operational-reports/export-domain.ts:41`) | **rewrite-only** (legacy URL commented out) | delete, or keep as a reachable feature only with sign-off (J5) |
| E1–E6 exports | in-process `reportExportWorker` (`src/modules/operational-reports/export-worker.ts`, `export-service.ts`); kinds `returned-orders`, `order-transactions`, `cash-balance`, `flash-sales`, `day-close-history`, `hyperlocal-daily` | diverges: lease/heartbeat; `report_exports` row created at request time (ledger) | jobs on `export_queue` (E1-E3, E5, E6) and `sales_queue` (E4), each writing `report_exports` exactly as legacy |
| — | export kinds `salesperson-performance`, `cashier-performance`, `hyperlocal-acceptance` (`export-domain.ts:73-106`) | **no Celery counterpart**; how legacy exported these (if at all) is UNKNOWN (possibly client-side DataTables) | decide with W5 |
| T1 | `pos_rewrite_login_security_alerts` + `worker:security` | diverges | in-process fire-and-forget (§4.6) |
| T2 | synchronous inside `src/auth/delivery.ts:243` | diverges (blocking) | fire-and-forget |
| T3 | `pos_rewrite_customer_registration_deliveries` via `worker:financial-outbox` | diverges | fire-and-forget with 20 s delay and Redis value check |
| T4 | `pos_rewrite_fulfillment_effects` kind `concurrency-sync` | diverges | fire-and-forget |
| T5 | fulfillment notifications via Redis pub/sub bus (`src/modules/fulfillment/notification-bus.ts`) | mechanism differs | job `order.views.advance_order_notification` with countdown 0, or inline |
| §2.8 scheduled reports | in-process `scheduledReportWorker` with `pos_rewrite_scheduled_reports` (→ Redis per ledger) (`src/modules/operational-reports/scheduled-worker.ts`) | **diverges: legacy is a synchronous HTTP call** | synchronous endpoints, or a job if the caller's timeout requires it (J4) |

---

## 4. Proposed design: one Redis-backed job queue (existing `redis` dependency)

### 4.1 Constraints that shape it

- Only `redis@6.3.1` is a dependency (`package.json:61`). **BullMQ requires `ioredis`**, which is not a direct
  dependency; the ledger's "BullMQ on the existing redis dependency" is therefore not possible without a new
  dependency. The design below uses node-redis primitives and Lua only.
- No tables. Job state lives in Redis; durable outcomes go to the same production tables legacy writes.
- Delivery semantics match legacy Celery: **at-most-once, no automatic retry** for every job; delayed jobs fire at
  their due time. The one place legacy was effectively at-least-once (Redis-broker countdown tasks redelivered after
  48 h on worker death) is reproduced only as far as "a delayed job survives worker restarts until due".
- Same Redis as the app (`config.REDIS_URL`, `src/config.ts:73`), `maxmemory-policy noeviction`.

### 4.2 Queues

Names are the legacy Celery queue names: `core`, `store`, `order`, `order_create`, `export_queue`,
`report_queue`, `sales_queue`. Job names are the legacy Celery task names (e.g. `core.tasks.send_sms`,
`order.tasks.auto_reject_timed_out_for_store`, `order.views.auto_hl_order_transfer`,
`report.datatables.sales_data.do_sales_export`), so logs and runbooks map one-to-one.

### 4.3 Keys

| Key | Type | Content | TTL |
|---|---|---|---|
| `pos:jobs:q:{queue}` | LIST | ready job ids (`LPUSH` producer, consumer pops from the right) | none |
| `pos:jobs:delayed` | ZSET | job id → due epoch ms | none |
| `pos:jobs:job:{jobId}` | STRING (JSON) | `{"id","name","queue","args":[…],"kwargs":{…},"enqueuedAt","dueAt","requestId","userId","state":"queued|delayed|started|succeeded|failed","startedAt","finishedAt","workerId","errorCode"}` — args must not contain PII beyond ids already in legacy task args; no request bodies | `EX 604800` (7 d), refreshed on each state change |
| `pos:jobs:inflight:{workerId}` | LIST | job ids taken by that worker and not yet finished | none; removed by the worker on exit |
| `pos:jobs:worker:{workerId}` | STRING | heartbeat timestamp | `EX 30`, refreshed every 10 s |
| `pos:jobs:failed` | LIST | ids of failed jobs (newest first) | `LTRIM 0 9999` after each push |

Job ids are UUIDv4 (`crypto.randomUUID()`).

### 4.4 Operations

- **Enqueue now** (`apply_async`/`.delay`): `MULTI { SET pos:jobs:job:{id} <json state=queued> EX 604800; LPUSH pos:jobs:q:{queue} {id} } EXEC`.
  Enqueue only after the caller's MySQL transaction commits (legacy enqueued mid-request without `on_commit`; the
  difference only shows when the request later fails).
- **Enqueue delayed** (`countdown`): `MULTI { SET job (state=delayed, dueAt) EX 604800; ZADD pos:jobs:delayed dueAt {id} } EXEC`.
- **Promote** (one promoter loop per worker process, every 1 s; concurrent promoters are safe): Lua
  `ids = ZRANGEBYSCORE delayed -inf now LIMIT 0 100; for each id: if ZREM delayed id == 1 then queue = cjson.decode(GET job).queue; set state=queued; LPUSH q:{queue} id end`.
- **Claim** (at-most-once = ack on receipt, as Celery): `BLMOVE pos:jobs:q:{queue} pos:jobs:inflight:{workerId} RIGHT LEFT <timeout>`
  across the consumed queues (iterate queues round-robin with a short timeout, mirroring one Celery worker consuming many
  queues), then set `state=started, startedAt, workerId`.
- **Finish**: `MULTI { SET job state=succeeded|failed …; LREM pos:jobs:inflight:{workerId} 1 {id}; [LPUSH pos:jobs:failed id; LTRIM …] } EXEC`.
  No retry on failure.
- **Crash**: ids left in `pos:jobs:inflight:{deadWorker}` (heartbeat key expired) are **not** re-run automatically
  (legacy loses them too). A worker CLI `--list-orphans` / `--requeue <jobId>` lets an operator re-run one on purpose.
  Re-running is safe only for jobs whose legacy body is guarded (O1 lock, O2/O3 `hyperlocal_order_log` guards); the CLI
  must print that warning.
- **Locks inside jobs** reuse legacy keys: `express_reject_lock:{store}` `SET NX EX HL_REJECT_LOCK_TTL_SECONDS`, released
  by token compare (Lua) rather than legacy's plain `DEL` (same effect without releasing another worker's lock).

### 4.5 Worker processes

- One script, `worker:jobs` (entry e.g. `dist/jobs/worker-main.js`; `package.json` is owned by the primary agent),
  consuming all seven queues, global concurrency `JOBS_CONCURRENCY` default **2** (`Dockerfile.celery:64`), plus the
  promoter loop. Graceful stop: stop claiming, finish in-flight jobs, then exit.
- Scale out by running more copies; the claim and promote steps are atomic.
- Logging: registered resource events with `requestId` and `userId` from the job record; never args or results
  (AGENTS.md logging rules).
- The API process only enqueues. It runs no job timers.

### 4.6 Fire-and-forget (threads T1–T4), kept in-process

Legacy daemon threads are not queued, and a crash loses them. Reproduce them with an in-process helper
(`void run().catch(log)` with a timeout and a small concurrency cap) and **not** with the queue, which would make them
more reliable than legacy. T3 must keep the 20 s delay and the "Redis key `{mobile}` still equals this OTP" check
(`helpers/helpers.py:1564-1579`).

### 4.7 Job catalogue (live jobs only)

| Job name | Queue | Mode | Producer in rewrite |
|---|---|---|---|
| `core.tasks.parse_csv_product_store` | `core` | now | inventory-import upload route |
| `core.tasks.parse_csv_product_stock` | `core` | now | inventory-import upload route |
| `core.tasks.send_sms` | `core` | now | checkout order placement (`AjaxOrderView` / fast checkout equivalents) |
| `core.tasks.new_order_create_communication` | `core` | now | inside `auto_hl_order_to_online` |
| `core.tasks.sync_ecom_inventory` | `core` | now | ecommerce settings update |
| `core.tasks.push_vinc_order_for_all` | `core` | now | return processing failure path |
| `order.tasks.auto_reject_timed_out_for_store` | `order` | now | the 3 hyperlocal progress endpoints |
| `order.views.auto_hl_order_transfer` | `order_create` | delayed | hyperlocal order intake service route |
| `order.views.auto_hl_order_to_online` | `order_create` | delayed or now | `auto_hl_order_transfer` |
| `order.views.advance_order_notification` | `order_create` (delayed) / `order` (now) | both | HL intake; express notify webhook |
| `report.datatables.return_orders_datatable.do_return_export` | `export_queue` | now | returns report export |
| `report.datatables.return_orders_datatable.do_order_export` | `export_queue` | now | orders data export |
| `report.datatables.cash_balance_datatable.do_cash_balance_export` | `export_queue` | now | cash balance export |
| `report.datatables.sales_data.do_sales_export` | `sales_queue` | now | sales data export |
| `report.datatables.day_close_datatable.do_day_close_export` | `export_queue` | now | day close export |
| `report.datatables.hyperlocal_daily_datatable.do_hyperlocal_daily_export` | `export_queue` | now | hyperlocal daily export |

Queues `store` and `report_queue` have no live job (S1 and R1–R5 are dormant); keep the names reserved.

---

## 5. Rewrite workers with no legacy counterpart (deletion candidates)

| Worker / loop | Why no counterpart | Citation |
|---|---|---|
| `worker:security` | prunes rewrite tables (TTL replaces) and delivers the lockout alert from an outbox (legacy: thread T1) | `package.json:20`, `src/auth/security-worker.ts:219-222` |
| `worker:profile-media` | deletes replaced profile images; legacy never deletes | `package.json:23`; ledger auth/profile-media |
| `worker:store-images` | same for store images | `package.json:24`; ledger administration/store-images |
| `worker:documentation-media` | same for tutorial media; legacy deletes synchronously (`core/views.py:2521-2522`) | `package.json:21` |
| `worker:customer-contacts` | customer-contacts feature removed (AGENTS.md); module still present at `324d62d` | `package.json:18`, `src/modules/customer-contacts/` |
| `worker:customer-otp` | legacy customer OTP is synchronous API-v2 `omnichannel-sendotp`/`verifyotp` (`order/views.py:2536-2596`); legacy returns need no OTP (`order/views.py:885-914`) | `package.json:19` |
| `worker:gift-card-batches` | legacy generation is synchronous (C11) | `package.json:17` |
| `worker:financial-outbox` (most of it) | only `order-sms` maps to a Celery task (C5); return mails, discount mails (C13/C14) and registration OTPs are synchronous or threads in legacy | `package.json:15`, `src/modules/checkout/worker.ts:52-68` |
| `worker:administration` (outbox part) | product-sync outbox; legacy calls `sync_pos_product` inline (`core/views.py:489,543,564,776`). The CSV part maps to C1/C2 | `package.json:16` |
| `worker:settings` (effects part) | settings effects (common-Redis mirror, Slack) are inline in legacy (`core/views.py:2035,2073,2146,2161`). The ecommerce part maps to C10 | `package.json:22` |
| in-process fulfillment timer | legacy has no timer (O1 is page-triggered) | `src/modules/fulfillment/worker.ts:235` |
| in-process whole-order-status loop + repair obligations | legacy C12 is a single fire-once task | `src/modules/legacy-order-status/background.ts:38` |
| in-process scheduled-report loop | legacy reports are synchronous HTTP endpoints | `src/modules/operational-reports/index.ts:194-195` |
| in-process local-delivery loop | replaced by delayed jobs O2/O3/O5 | `src/modules/legacy-fulfillment/lifecycle/index.ts:297` |
| in-process report-export loop | replaced by export jobs E1–E6 | `src/modules/operational-reports/index.ts:193` |

Already removed by W2 at `324d62d`: `worker:order-imports`, `worker:coupon-history`, `worker:membership-history`,
`worker:screening-counter`, `worker:origin-history`, `receiver:whole-order-status`, `receiver:origin-history`.

---

## NEEDS USER DECISION (jobs)

- **J1 — Order SMS transport.** Legacy C5 asks API-v2 `omnichannel-sms` to send; the rewrite sends via Gupshup itself.
  Strict parity says call API-v2.
- **J2 — Hyperlocal expiry trigger.** Legacy processes expiries only when someone opens a progress page (O1). The
  rewrite's 1 s timer changes when orders get rejected or auto-packed. Strict parity says page-triggered.
- **J3 — Gift-card batch generation inline vs queued.** Legacy is synchronous in the request (C11) and returns after
  generation, upload and email. Large batches may exceed proxy timeouts (UNKNOWN). Inline (parity) or a `core` job.
- **J4 — Scheduled Slack reports (§2.8).** Legacy runs them synchronously in the HTTP request of an unknown external
  scheduler. Keep synchronous, or enqueue and return 202 (changes the caller contract).
- **J5 — Rewrite-only exports** (`current-inventory-workbook`, `salesperson-performance`, `cashier-performance`,
  `hyperlocal-acceptance`): delete, or keep as approved additions.
- **J6 — Strict mode.** Legacy MySQL connections run `SET sql_mode='STRICT_TRANS_TABLES'` (`POSAdmin/settings.py:183,203,222`),
  which contradicts AGENTS.md's statement that production runs with an empty `sql_mode`. Jobs that write enums
  (`pos_csv_upload.upload_type`, `express_line_item.status`) behave differently under each mode. Confirm which session
  mode the rewrite should use.

## UNKNOWN

- Celery broker transport and host (`CELERY_BROKER_URL`), and result backend.
- Who calls the §2.8 report endpoints, and on what schedule.
- Whether T5 always completes under the dev server's `async_to_sync` loop.
- Whether production still uses the Flower deployment.
