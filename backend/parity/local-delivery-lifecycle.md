# Local delivery (hyperlocal) lifecycle

Source: `backend-pos-web@78d5b63`. Module: `src/modules/legacy-fulfillment`
(`hyperlocal.ts`, `stock.ts`, `runtime.ts`, `gateway.ts`, `actions.ts`, `jobs.ts`).
Rewritten by W5 (19 November 2026) as a direct port. The rewrite-only saga (command,
provider-call, delayed-job and reservation tables, the in-process worker and manager
reconciliation) is deleted. ExpressLineItem remains the separate `fulfillment` module.

## Behaviour map

| Legacy | Rewrite |
|---|---|
| `AutoHlOrderView.post` `order/views.py:3675-3720` | `POST /orders/auto-hl-order/` and `/api/v1/orders/auto-hl-order/` (form body, `APPID`/`APPKEY`). Advance-slot check and `order_addons.order_success_timestamp`; O5 enqueued (`order_create`, countdown = advance buffer) or the T5 notification fire-and-forget; holds; O2 enqueued (`order_create`, countdown = cut-off seconds or `ORDER_CREATION_BUFFER_TIME_IN_SEC` + advance buffer); "first lands on" transaction log. |
| `auto_hl_order_transfer` (O2) `:3844-3935` | `lifecycle.transfer` = job handler and `AjaxPassOrderView` (sync, `is_auto=False`). Same guards (`hyperlocal_order_log.action`, `orders.is_transfer`), notifications with ❌, unhold/hold, `order_transferred_timestamp`, O3 enqueue with the legacy positional quirk (dropdown text lands in `staff_user`), ⏱️ Slack when automatic. |
| `auto_hl_order_to_online` (O3) `:3937-4029` | `lifecycle.toOnline` = job handler, `AjaxHlOrderView.create` failure path and `AJaxConvertOnlineView` (sync). Online eligibility on `product_stocks.stock`, cancel + OD ticket on failure, child-order guard, `create_online_order` writes, HL-charge refund (`tss_money_history`, `users`), C9 enqueue, ticket, log, `unhold_for_convert`. |
| `AjaxHlOrderView.create/cancel` `:3433-3663` | `POST …/local-deliveries/orders/:orderId/courier-requests` and `/cancellations`. |
| `WebhookCancelledOrderView` `:4277-4312` | `POST /orders/webhook-cancelled-order/` and `/api/v1/orders/…` (TSS observer credentials), literal legacy reply. |
| `AjaxCheckOrderStatusView`, `AjaxOrderPackView`, `AjaxRtoRecievedView` | `GET/PUT/POST /api/v1/stores/:storeId/legacy-fulfillment/orders/:orderId[/packing|/rto-receipts]`. |
| `core.tasks.new_order_create_communication` (C9) `core/tasks.py:170` | Job handler: `POST MJML_HOST api/v2/mailr/hyper_local/order_new/ {"order_id": N}`; non-200 only logged. |

Legacy quirks kept on purpose: split orders keep `location_id`/status on courier
acceptance (legacy compares the FK object with `1`, `views.py:3504`); the transfer
path's O3 args; `"Order cancelled/refund: {resp} {error_msg}"` is not an f-string;
`is_notify` is truthy for any non-empty value; `fd_ticket_id` "0" is appended.

## Messages (legacy → rewrite, S4)

| Case | Legacy | Rewrite |
|---|---|---|
| Service credentials wrong/missing | 401 `{"status":"401","message":"Authentication Failed"}` (missing header = 500 KeyError) | 401, same body |
| Courier creation refused | 200 `{"message":"Failed","status":"400","error":"{'Order': 'Order Already created'}"}` | 409 `LOCAL_DELIVERY_COURIER_FAILED` "Order: Order Already created" |
| Courier rejected → online conversion | 200 `{"status":"400","convert":true,…}` | 409 `LOCAL_DELIVERY_CONVERTING` with the same dictionary text |
| Cancel refused (`Already refunded`, API text) | 200 `{"message":"Failed","status":"400"}` | 409 `LOCAL_DELIVERY_CANCEL_FAILED` |
| RTO conversion refused (`Order Already …`, stock) | 200 `{"status":400,"message":…}` | 409 `LOCAL_DELIVERY_CONVERSION_REFUSED`, legacy message |
| Order not at this store | (legacy: no check) | 404 `LEGACY_ORDER_NOT_FOUND` |
| Concurrent action on the order | (legacy: none) | 409 `LOCAL_DELIVERY_IN_PROGRESS` |
| Queue not wired | (legacy: Celery error → 500) | 503 `JOB_QUEUE_UNAVAILABLE` |
| RTO repeat | 200 "RTO Order Delivered" and restocks again | 200 "RTO Order Delivered", `alreadyRecorded: true`, no restock (ledger-approved correction) |

## Gaps

- `CORE_WAREHOUSE` hold/unhold (`vinc_stock_sync` + `products.{db_column_name}`) is not
  ported; it returns the legacy "fail" result and is logged, so no hold is recorded for
  warehouse locations.
- `sync_pos_inventory` is the configured stock projection; without
  `POS_STOCK_PROJECTION_CONTRACT`/`POS_SYSTEM_STOCK_PROJECTION_CONTRACT` holds fail (logged,
  as a failed legacy hold) and RTO receipt returns 503.
- No sandbox evidence for Borzo, API-v2, order producer, mailr or Slack.
