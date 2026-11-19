# Inventory CSV imports (jobs C1/C2)

Source: `backend-pos-web@78d5b63`. Upload views `ProductsStoreBulkUploadView` / `ProductsStockBulkUploadView`
(`core/views.py:122-142,374-397`), tasks `core.tasks.parse_csv_product_store` / `parse_csv_product_stock`
(`core/tasks.py:28-48`), bodies `ProductStoreParseCSV` / `ProductStockParseCSV` (`helpers/task_helpers.py:64-350`).
The product-store upload URL is commented out in the source (`core/urls.py:11`); its task is live code.

## Upload (`POST /api/v1/admin/inventory-imports`)

Body `{type: PRODUCT_STOCK_CSV|PRODUCT_STORE_CSV, name, csv}` (zod; `name` must end in `.csv`, CSV at most
256 KiB). Steps, as the source view: store the file under `uploads/csv/Csv-%Y_%m_%d-%H-%M-%S.csv` (business
time zone; django-storages `_xxxxxxx` suffix on a name clash) through `import-storage.ts` (S3 `PutObject`
with `If-None-Match: *`); insert `pos_csv_upload` (`upload_type`, `uploaded_by`, `filename`,
`is_imported=0`, timestamps); set the Redis cursor; enqueue the task on queue `core` with
`{upload_id, user_id, role_id}` after the insert. Response 201 `{id, message}`.

| Case                        | Legacy                                                                                       | Rewrite                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| accepted                    | flash "Csv Uploaded successfully. Data may take some time to reflect."                       | 201, same message                                            |
| bad file/extension          | flash "Invalid / Blank parameters passed in field." / form error "Only CSV file is accepted" | 400 (zod) "Only CSV file is accepted"                        |
| no storage or job queue     | 500                                                                                          | 503 `DEPENDENCY_UNAVAILABLE`                                 |
| not roles 1-3 / user_type 2 | page allowed                                                                                 | 403 `ROLE_ACCESS_DENIED` / `INVENTORY_ADMINISTRATION_DENIED` |

`GET /api/v1/admin/inventory-imports/template?type=` returns the source download rows with `csv.writer`
quoting, file name `ProductStock-<ts>.csv` / `ProductStore-<ts>.csv`. `GET /api/v1/admin/inventory-imports`
(`type`, `before`, `limit`) and `GET .../:uploadId` read `pos_csv_upload` (the source upload-log datatable is
commented out, `core/urls.py:48-51`); role 1 sees every upload, other roles only their own; detail parses
`failed_data`. `GET .../capabilities` stays for the catalog product screen.

## Job handlers (`import-job.ts`, registered in `jobs.ts`)

Reproduced exactly: active-store and `user_stores` lists read once at start; `role_id != 1` store check;
`csv.DictReader` over UTF-8 lines (BOM kept in the first header, lone `\r` raises mid-iteration); Python
`int()` parsing and messages; `failed_data` written with `json.dumps` defaults (`", "`, `": "`,
`ensure_ascii`); source messages ("Not a valid store.", "Not a parent product.", "Not a valid store for
requested user.", "Required parameters are missing.", "Error while traversing csv data." with
`other_error`, "Stock is not available to hold."); `message` "Product Store/Stock Data Updated
Successfully."; `is_imported=1`; then one `sync_pos_product` POST with the source `product_id_list`
(duplicates kept). Stock procedure: `GenericHelper.sync_pos_inventory` calls (`tss.pos_stock_syncer` via
`stock-procedure.ts`, or the configured transaction-scoped projection) once per existing association; the
first failure stops the calls and is logged, as the source `try` around the loop.

Source quirks kept on purpose:

- `IsHold=0` with a quantity also holds (the unhold `elif`, `:265-292`, is unreachable). Previous rewrite
  corrected this; that correction is removed. See NEEDS USER DECISION in the W8b report.
- A hold failure does not stop the record: listing flags are still updated, and the product is not synced.
- A later exception re-appends the same failure dict, so it appears twice in `failed_data`.
- Writes before an exception inside a record stay (e.g. flags, then the missing product's
  `'NoneType' object has no attribute 'parent_prod_id'`).
- Product-store inserts are collected and inserted together at the end; a repeated active record hits the
  production `uq_product_store` key, so the task ends with the upload unimported (source `bulk_create`).
- A missing required header (or a BOM before `SkuId`) ends the task before any record (`row_dict` is
  unbound in the source), leaving the upload unimported. A malformed line ends it after earlier records.

Rewrite-only additions: each record runs in one writer transaction (savepoint around each procedure call);
the Redis cursor `pos:import_progress:{uploadId}` (JSON `{record, failed, productIds, inserts}`, EX 7 days)
advances after each committed record; a run whose cursor is missing closes the upload with
`is_imported=1` and message "Import was interrupted and has not been resumed. Please upload the remaining
records again." instead of re-applying holds (ledger risk note). `pos:lock:import:{uploadId}` (15 min,
refreshed per record) prevents two runs of one upload. Non-Python errors are recorded as
"Unexpected error while processing the record." (no raw SQL text).

Removed (no legacy home): `pos_rewrite_inventory_imports`, `_rows`, `pos_rewrite_parent_store_import_audits`,
preview, row listing, failures CSV, resume/cancel, BLOCKED/CANCELLED states, checksum replay, per-actor
queue limit, BigQuery completed history (`BQ_INVENTORY_IMPORTS_VIEW`, `BQ_INVENTORY_IMPORT_ROWS_VIEW`,
`BQ_PARENT_STORE_IMPORTS_VIEW`, `BQ_PARENT_STORE_IMPORT_ROWS_VIEW` are unused) and `worker:administration`.

Tests: `tests/administration/import-domain.test.ts` (goldens + CPython-derived vectors),
`tests/administration/inventory-jobs.mysql.test.ts` (`INVENTORY_JOBS_MYSQL_TEST_URL` or
`ADMINISTRATION_MYSQL_TEST_URL`, loopback MySQL; fake storage/procedure/sync, memory Redis).
