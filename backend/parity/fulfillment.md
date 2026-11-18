# Fulfillment migration evidence

Source baseline: `backend-pos-web` commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

The plugin implements 19 resource routes. This is implementation coverage, not certification of all legacy routes or production integrations.

| Source surface | Rewrite |
|---|---|
| Hyperlocal progress page, content refresh, load more, tab counts | `GET /api/v1/stores/:storeId/fulfillment/{summary,orders}`; `FulfillmentPage` |
| Pending/accepted expiry banners | `GET .../fulfillment/expiry-alerts` |
| Rejection reason list | `GET /api/v1/fulfillment/rejection-reasons` |
| Bulk ACCEPT / REJECT / PACK | `POST .../fulfillment/orders/:orderId/{acceptance,rejection,packing}` |
| Individual accepted-line packing | `PUT .../orders/:orderId/lines/:lineId/packing` |
| Ship and RTO receipt | `POST .../orders/:orderId/{shipment,rto-receipt}` |
| Courier AWB shipment API | `POST /api/v1/webhooks/express-shipments`, header `X-API-Key` |
| New express-order notification webhook | `POST /api/v1/webhooks/express-orders`, headers `APPID` / `APPKEY` |
| Notification list/read/live delivery | scoped `/notifications`, `/notifications/:notificationId/read-receipt`, `/notifications/stream`; `NotificationsPanel` |
| All-store dashboard and AJAX data | `GET /api/v1/fulfillment/store-monitoring`, `/store-monitoring/stores`; `FulfillmentMonitoringPage` |
| Superadmin status/expiry editor | `PATCH .../fulfillment/orders/:orderId` |
| Expiry/auto-pack/allocation-retry Celery job | `maintenance.runStore`, called by enabled background worker |

`GET /api/v1/fulfillment/commands/:commandId` reports committed local actions and individual integration states. Actions never report external completion while effects remain pending, blocked, or uncertain. Browser commands retain their immutable command IDs across a lost response. Retry metadata is scoped to the operator/store/order.

## Verified evidence

- The actual Python card helper is executed with inert query adapters for 27 cases, including duplicate HP allocation sets, split shipment/AWB flags, float rounding, and RTO flags.
- Original pending-expiry and accepted-auto-pack helpers are executed for 32 allocation/status cases. Delayed allocation retry is tested separately and on isolated MySQL.
- Actual Python request helpers are executed with an inert request recorder for PACK/SHIP, RTO, mailr and signed concurrency deltas. A separate test preserves 64-bit numeric HP IDs in warehouse conversion JSON.
- Isolated local MySQL exercises concurrent idempotent actions, store scoping, status logs, line/bulk packing, HP/order shipping, received-RTO guards, timeout/allocation retry, auto-pack, courier idempotency, notification deduplication, uncertain effects, per-store counter order across workers, and sanitized request/user trace propagation.
- A dedicated ephemeral local Redis process verifies recipient/store isolation and omission of recipient lists from client events.
- Fastify tests verify missing/invalid service credentials cause 401 before DB work even when a browser cookie is present, browser operator/store boundaries, exact WebSocket Origin, and revoked-session closure.
- Monitoring tests verify warehouse routing for expiry-selected cohorts, pair pagination, per-status distinct counts, split pairs, packed timers, and zero MySQL report reads for historical warehouse queries.

No live DB writes, real Slack messages, fulfillment actions, or customer notifications were used to produce this evidence. External delivery success and live warehouse equivalence still require configured test adapters and acceptance evidence.

## Deployment and delivery

Apply `src/modules/fulfillment/migration.sql` to the writer using the shared migration runner. It creates only rewrite-owned command/effect/event state. Notification recipients use the administration module's SQL check-ins, so its migration is also required.

Worker options are validated in `options.ts`:

| Option | Default |
|---|---|
| `FULFILLMENT_WORKER_ENABLED` | `false`; ignored in demo mode |
| `FULFILLMENT_WORKER_INTERVAL_MS` | `1000` |
| `FULFILLMENT_MAINTENANCE_INTERVAL_MS` | `30000` |
| `FULFILLMENT_WORKER_BATCH_SIZE` | `25` |
| `FULFILLMENT_WORKER_CONCURRENCY` | `4` |
| `HL_TIMED_OUT_REASON_ID` | `5` |
| `VINC_ALLOCATED_STATUSES` | `Allocated,Part Allocated` |

The plugin starts the worker on Fastify readiness only when explicitly enabled, and awaits delivery shutdown before closing Redis. Claims use `FOR UPDATE SKIP LOCKED`; core effects follow command sequence; counter deltas are also serialized by store and monotonic dispatch order. SQL store/line locks serialize expiry mutations. Batches expose cursors so unresolved early orders cannot starve later orders. Slack failures cannot block later core effects solely by occupying an earlier notification sequence.

The pre-order HTTP service remains the counter authority. `REDIS_URL` is **only** POS notification pub/sub, not the pre-order counter database. A response lost after an HTTP delta becomes `UNCERTAIN`; no automatic delta retry occurs. `outbox.reconcile` is an internal operational method and must only be invoked after confirming the external outcome; there is currently no public reconciliation UI or route.

Required delivery configuration: `PREORDER_URL`, `PREORDER_INTERNAL_KEY`, `BACKEND_SYNC_API_BASE_URL`, `BACKEND_SYNC_REPO_API_KEY`, shared `TSS_API_BASE_URL`, `API_V2_APP_ID`, `API_V2_APP_KEY`, and `MJML_HOST`. `REDIS_URL` is required for live notifications and requires TLS for remote production brokers. Store Slack URLs and optional `SLACK_URL` / `COMMON_GROUP_ALERT_ON` preserve routine versus abnormal channel rules. Webhook secrets are independent (`APP_ID`/`APP_KEY`, `EXPRESS_ORDER_API_KEY`). Secrets are accepted only in headers and never logged.

Worker events contain static module/resource/event IDs, fresh event-instance IDs, originating request/user IDs where available, and safe status/error codes. They exclude request bodies, query values, payloads, raw errors, SQL, URLs, credentials, names, phone numbers, and addresses.

## Warehouse contract

All date-selected monitoring, including today, uses `warehouseService.queryReport` with resource `fulfillment-monitoring`, named bound parameters and the shared cost/time/row guards. Expiry-date selection does not bound original Order/HP fact age, so there is no DATA report fallback. Interactive per-store detail/actions remain on the primary/writer regardless of order age.

Configure fully qualified `project.dataset.table` identifiers for these raw tables or compatible views. No project/dataset/table is guessed:

| Option | Required columns |
|---|---|
| `BQ_FULFILLMENT_EXPRESS_LINES` | `id,order_id,store_id,has_product_id,status,pending_expires_at,accepted_expires_at,vinc_status,updated_at` |
| `BQ_FULFILLMENT_ORDERS` | `id,order_ref_no,user_id,first_name,last_name,created_at,payment_status,order_status` |
| `BQ_FULFILLMENT_HAS_PRODUCTS` | `id,prod_id,qty,pre_gst_amt,gst,awb,shipment_id,status,price` |
| `BQ_FULFILLMENT_PRODUCTS` | `id,product,parent_prod_id,images_new` |
| `BQ_FULFILLMENT_STORES` | `id,store_name` |
| `BQ_FULFILLMENT_ORDER_STATUSES` | `id,order_status` |
| `BQ_FULFILLMENT_PAYMENT_STATUSES` | `id,payment_status` |
| `BQ_FULFILLMENT_STATUS_LOGS` | `order_id,store_id,new_status,changed_at` |

Related ID types must agree across joins. Datetimes must represent the same business-local MySQL DATETIME values; no implicit timezone conversion is permitted in the views. Runtime DTO validation rejects missing/incompatible columns. A missing mapping fails with 503; history is never silently sent to MySQL.

## Deliberate interface changes and remaining work

Resource JSON replaces HTML partials and session-stored dashboard filters. Invalid fields are rejected instead of silently coerced. Dashboard reads are limited to assigned stores (superadmin may select all); the source allowed any logged-in user to inspect all stores. Reports enforce bounded date/page/row limits. Source status/count/arithmetic semantics are retained inside those boundaries, including the all-store dashboard's summed distinct counts across shipped/rejected statuses.

End-to-end browser/desktop parity for every legacy template, real adapter sandbox tests, live BigQuery snapshot comparison, operator reconciliation controls, and production sizing remain release work. Specialized daily reports and all seven active scheduled hyperlocal/CRM groups now have separate implementations and evidence in `hyperlocal-daily.md` and `scheduled-reports.md`.

Notification cursor/read/update/auto-insert fixtures include IDs above 2^53. BIGINT IDs use BigInt binds and string DTOs; the shared exact native generated-ID helper avoids Drizzle numeric returning-ID loops. Slack data strings escape injected links/mentions, with automatic linking and unfurls disabled.

Authoritative mutation guards now re-read active operator role/store assignment with shared writer locks inside accept/reject/pack/ship/RTO, replay, administrator edit and notification mark-read transactions. Command receipts also recheck writer scope. Courier execution uses a private capability path behind independent service-header authentication; a browser-supplied service actor cannot bypass writer authorization. Local MySQL regressions verify revoked assignments, stale admin roles, inactive accounts, replay and receipt denial. Normal interactive card scope is already writer-current in root authentication; card data stays on the primary reader.
