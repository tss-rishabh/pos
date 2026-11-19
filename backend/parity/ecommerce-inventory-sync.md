# Ecommerce inventory sync (job C10)

Source: `AjaxEcomSettingUpdate.run_sync` (`core/views.py:2166-2167`) enqueues
`core.tasks.sync_ecom_inventory(store_id)` (`core/tasks.py:181-206`).

`ecommerce-sync/job.ts`, registered as `core.tasks.sync_ecom_inventory` on queue `core`:

1. read `stores.ecom_threshold` of the active store (any type);
2. for every `product_store` row of that store with `stock > ecom_threshold` (no other filter, id order),
   `CALL pos_stock_syncer_bk(store, product, '<stock>', 0, 0, 'Updated by System')`, values bound (the
   source interpolates them into the SQL string);
3. `GET MAIN_API_V2_URL + "syncproduct"`, any error ignored (`except: pass`).
   Any failure in 1-2 stops the run and is logged (`administration.ecommerce-inventory-sync.failed`) without
   the full sync, as the source's outer `try`. No retry.

Notes: `stock-projection.md` records that `pos_stock_syncer_bk.sql` does not match the verified physical
schema; if the deployed procedure is missing the job logs a failure exactly where the source would.
`redirect: 'error'` and a 30 s timeout bound the `syncproduct` call (source follows redirects, no timeout).

Removed (no legacy home): `pos_rewrite_ecommerce_inventory_syncs`, `_sync_rows`, the operation/status/retry/
records/cancellation routes, the signed full-sync bridge (`ECOMMERCE_FULL_SYNC_*`,
`ECOMMERCE_SYNC_BATCH_SIZE`, `ECOMMERCE_SYNC_MAX_PRODUCTS`) and the browser journal.

Tests: `tests/administration/inventory-jobs.mysql.test.ts` (C10 case, fake syncer and full sync).
