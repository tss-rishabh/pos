# Express / hyperlocal fulfilment parity notes (W5, schema freeze)

Legacy source: `backend-pos-web@78d5b63` — `order/views.py:4667-5580`, `order/tasks.py`,
`order/hl_all_stores.py`, `helpers/helpers.py` (`slack_text_notification` `:1093-1130`,
`call_status_api` `:1133-1158`, `call_express_out_for_delivery_api` `:1194-1200`,
`express_concurrency_sync` `:1616-1670`, `check_api_key` `:1717-1720`),
`helpers/notification_helpers.py:40-57`, templates `order/templates/order/hyperlocal/*`.

This file is implementation notes, not parity certification.

## Runtime shape

- No outbox, worker or timer. `pos_rewrite_fulfillment_commands`, `pos_rewrite_fulfillment_effects`
  and `pos_rewrite_notification_events` are no longer read or written by this module
  (`schema.ts` keeps two Drizzle definitions only for callers outside W5: `finance/alerts.ts`,
  `legacy-fulfillment/lifecycle/notice.ts`).
- Express actions write `express_line_item`, `express_order_status_log`, `has_products`, `orders`
  in one writer transaction and then call the legacy side effects inline, in legacy order,
  each at-most-once with the legacy timeout; failures are only logged (`effects.ts`).
- O1 `order.tasks.auto_reject_timed_out_for_store` is enqueued (queue `order`) by the progress
  view and the progress content view (offset 0) for the viewer's Redis check-in store, never on
  Load More, and runs under `express_reject_lock:{store}` (`SET NX EX HL_REJECT_LOCK_TTL_SECONDS`,
  token-compare release) (`expiry.ts`, `jobs.ts`).
- O5 `order.views.advance_order_notification` handler = `createOrderNotification`
  (`notifications.ts`); the new-order webhook enqueues it per store with `send_to_common=false`.
- T4 concurrency sync is in-process fire-and-forget (cap 16 in flight, 10 s timeout), never queued.
- All-stores monitor reads MySQL `data` (legacy `READ_DB_ALIAS`), every store, any signed-in user.

## Routes

| Legacy | Rewrite |
|---|---|
| `hyperlocal/progress/` GET (+O1) | `GET /api/v1/fulfillment/progress?tab=` (+O1), `GET /api/v1/fulfillment/progress/orders?tab=&offset=0` (+O1) |
| `ajax-hyperlocal-progress-data/` (+O1) | `GET /api/v1/fulfillment/progress` |
| `ajax-hyperlocal-progress-content/` (+O1) | `GET /api/v1/fulfillment/progress/orders?offset=0` |
| `ajax-hyperlocal-load-more/` | `GET /api/v1/fulfillment/progress/orders?offset=N` (no O1) |
| `ajax-express-line-items-bulk-action/` ACCEPTED / REJECTED | `POST /api/v1/stores/:storeId/fulfillment/orders/:orderId/acceptance` / `rejection` |
| `ajax-express-order-pack-all/` | `POST …/packing` |
| `ajax-express-order-mark-shipped/` | `POST …/shipment` |
| `ajax-express-order-mark-rto/` | `POST …/rto-receipt` |
| `ajax-express-line-item-pack/` | `PUT …/lines/:lineId/packing` |
| `ajax-hl-admin-edit/` | `PATCH /api/v1/stores/:storeId/fulfillment/orders/:orderId` |
| `ajax-hyperlocal-rejection-reasons/` | `GET /api/v1/fulfillment/rejection-reasons` |
| `ajax-hyperlocal-expiry-alerts/` | `GET /api/v1/stores/:storeId/fulfillment/expiry-alerts` (store must be the check-in store) |
| `hyperlocal/all-stores/`, `ajax-hyperlocal-all-stores-data/` | `GET /api/v1/fulfillment/store-monitoring`, `/stores`, `/defaults` |
| `ajax-express-order-notify/` (APPID/APPKEY, JSON) | same legacy paths `/orders/…` and `/api/v1/orders/…`, same headers, body and replies |
| `ship-express-order/` (`apikey`, form body) | same legacy paths, same header, form body and replies |

## Messages (S4): legacy → rewrite

Session routes use HTTP status codes. The two service webhooks keep the legacy reply bodies and
status codes byte-for-byte because external senders depend on them.

| Case | Legacy (HTTP, body) | Rewrite |
|---|---|---|
| Missing/invalid action input | 200 `{"message":"Invalid request","status":"400"}` | 400 `INVALID_REQUEST` "Check the request fields." |
| Reject without reason | 200 `Rejection reason is required` | 400 `REJECTION_REASON_REQUIRED` "Rejection reason is required" |
| Inactive/unknown reason | 200 `Invalid rejection reason` | 400 `INVALID_REJECTION_REASON` "Invalid rejection reason" |
| No order lines in store | 200 `Success`, 0 updated | 404 `FULFILLMENT_ORDER_NOT_FOUND` "No line items found for this order and store." |
| Accept/Reject before allocation (card hid buttons) | badge "Waiting for Allocation" | 409 `FULFILLMENT_AWAITING_ALLOCATION` "Waiting for Allocation" |
| Timed-out order (card) | badge "Expired – Waiting for Allocation" | 409 `FULFILLMENT_EXPIRED_AWAITING_ALLOCATION` same text |
| Accept after window (JS) | "The acceptance window for this order has expired. It will be automatically rejected." | 409 `FULFILLMENT_ACCEPTANCE_EXPIRED` same text |
| Reject on not_packed (button commented out) | — | 409 `FULFILLMENT_REJECT_AFTER_ACCEPTANCE` "Accepted orders cannot be rejected. Pack the order or wait for the packing window." |
| Pack without shipment id | disabled "Waiting for Shipment ID" | 409 `FULFILLMENT_AWAITING_SHIPMENT_ID` "Waiting for Shipment ID" |
| Pack after accepted window (timer disabled button) | — | 409 `FULFILLMENT_PACKING_EXPIRED` "The packing window for this order has expired. It will be packed automatically." |
| Ship without AWB | disabled "Waiting for AWB" | 409 `FULFILLMENT_AWAITING_AWB` "Waiting for AWB" |
| Ship with no PACKED lines | 200 `No packed items found` | 409 `FULFILLMENT_STATE_CONFLICT` "No packed items found" (courier webhook: legacy body) |
| RTO with no OFD lines | 200 `No out-for-delivery items found for RTO` | 409 `FULFILLMENT_STATE_CONFLICT` same text |
| RTO not all RTO_DELIVERED | 200 `Not all items are in RTO_DELIVERED status` | 409 `RTO_NOT_RECEIVED` same text |
| Line pack not ACCEPTED | 200 `Line item not found or not in ACCEPTED state` | 409 `FULFILLMENT_STATE_CONFLICT` same text |
| Admin edit non-role-1 | 403 `{"success":false,"error":"Unauthorized"}` | 403 `ROLE_ACCESS_DENIED` |
| Admin edit nothing / bad status / bad datetime | 400 `Nothing to update` / `Invalid status` / `Invalid … expiry format` | 400 `INVALID_REQUEST` with field message `Nothing to update` / enum error / `Invalid expiry format` |
| Admin edit no lines | 404 `No line items found for this order` | 404 `FULFILLMENT_ORDER_NOT_FOUND` same text |
| Notify auth / JSON / fields | 401 `Authentication Failed`, 400 `Invalid JSON`, 400 `order_id and store_ids are required` | identical |
| Notify with no job queue | (Celery broker down → 500) | 503 `JOB_QUEUE_UNAVAILABLE` |
| Courier auth / fields / store | 401 `{"status":"failed","message":"wrong api key"}`, 200 `Invalid request`, 200 `Could not resolve store for order/awb` | identical |

## Deliberate differences

- Session actions require the operator's store assignment (legacy accepted any `store_id` from any
  signed-in user) and the legacy card guards are enforced server-side.
- Slack text escapes `&<>` in interpolated data and only posts to `https://hooks.slack.com` URLs.
- The new-order webhook validates `order_id`/`store_ids` as positive integers and an array (legacy
  iterated whatever `store_ids` was).
- The courier webhook parses only `application/x-www-form-urlencoded` (legacy `request.POST` also
  parsed multipart).
- O1 is not enqueued for store 0 (not checked in); the legacy run for store 0 finds no rows.
