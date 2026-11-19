# Product synchronization (`sync_pos_product`)

The administration outbox (`pos_rewrite_administration_outbox`) and `worker:administration` are removed.
Legacy calls `Helpers.sync_pos_product` inline after each change (`core/views.py:489,543,564,776`;
`helpers/helpers.py:192-202`) and at the end of the CSV tasks (`helpers/task_helpers.py:168-172,348-350`).
`product-sync.ts` `productSynchronizer` does the same: one `POST {base}{PRODUCT_SYNC_URI}` with
`{"product_id_list":[...]}` (integer JSON, duplicates kept), base `MAIN_API_V2_URL` or `API_V2_URL` by the
migration flag. A non-200 or network failure is logged as `administration.product-sync.failed` and never
raised (legacy logs non-200; it would raise on a connection error). No retry.

Stock edits sync `[productId]` and visibility edits sync the selected `prod_id` only, as the source.
`PRODUCT_SYNC_REPLAY_SAFE` now gates only the retrying catalog-maintenance caller.

`enqueueInventorySynchronization` / `enqueueSystemInventorySynchronization` remain as record-only shims for
checkout and fulfillment callers; they no longer cause any sync. Their owners must call the synchronizer
after commit (see the W8b report gaps).
