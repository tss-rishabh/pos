# Local delivery status, packing and return receipts

Source baseline: `backend-pos-web@78d5b63`. See `local-delivery-lifecycle.md` for the full
behaviour map, messages and gaps. This page covers the three operator reads/writes.

| Source | Rewrite |
|---|---|
| `AjaxCheckOrderStatusView.post` `order/views.py:4041-4056` | Status `check` block: the five legacy branches and messages, first log by id, including the stored Borzo `error_msg`. |
| `AjaxOrderPackView.txn_logger` `:4144-4150` | Sets `is_pack=1` on every log of the order and writes `"{note}, Order Packed By: {first_name}"` (`None` when NULL) with `store_id` 0. |
| `AjaxRtoRecievedView` `:4063-4120` | Sets `rto_recieved=1`; for an SW order restocks every line's `product_store` row by `qty` through the stock projection with "Product inventory added from admin panel on Hyperlocal RTO, [Order ID:N]", then `sync_pos_product`; logs `"{note}, RTO Package Recieved By: {first_name}"`. A repeat is recorded once (gate on `rto_recieved` in the same writer transaction). |

The rewrite-only command receipts (`pos_rewrite_legacy_fulfillment_commands`) and RTO
receipts (`pos_rewrite_legacy_rto_receipts`) are deleted; durable state is only
`hyperlocal_order_log`, `product_store`, `pos_transaction_logs` and the stock logs.
