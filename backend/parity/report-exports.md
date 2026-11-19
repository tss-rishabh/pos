# Report exports (legacy Celery jobs E1–E6)

Legacy `backend-pos-web@78d5b63`. Current code: `src/modules/operational-reports/{export-routes,export-service,export-domain,export-storage,jobs}.ts`.
Superseded: the durable `pos_rewrite_report_exports` queue, its lease/heartbeat worker, the BigQuery export
archive and the server-side column-variant exports (deleted in W8, phase-c-legacy-jobs.md §2.6, §5).

## Flow (as legacy `report/datatables/*.py`)

1. `POST /api/v1/report-exports {input}` validates the filters with zod, checks store access, and enqueues one
   job with ids and scalars only. No `report_exports` row exists yet, as in legacy (`handle_export`).
   The response is the legacy queued message.
2. `worker:jobs` runs the job (`src/jobs`):

| Job | Queue | Legacy | `report_type` | Statuses written |
|---|---|---|---|---|
| E1 `report.datatables.return_orders_datatable.do_return_export` | `export_queue` | `return_orders_datatable.py:62-156` | `RETURN` | `Processing` → `COMPLETED` (no failure branch) |
| E2 `…return_orders_datatable.do_order_export` | `export_queue` | `:327-509` | `ORDER` | `Processing` → `COMPLETED` |
| E3 `report.datatables.cash_balance_datatable.do_cash_balance_export` | `export_queue` | `cash_balance_datatable.py:82-135` | `CASH_BALANCE` | `Processing` → `Completed` / `FAILED` |
| E4 `report.datatables.sales_data.do_sales_export` | `sales_queue` | `sales_data.py:65-145` | `RETURN` (legacy mislabel, `:84`) | `Processing` → `COMPLETED` |
| E5 `report.datatables.day_close_datatable.do_day_close_export` | `export_queue` | `day_close_datatable.py:215-317` | `DAY_CLOSE` | `Processing` → `Completed` / `FAILED` |
| E6 `report.datatables.hyperlocal_daily_datatable.do_hyperlocal_daily_export` | `export_queue` | `hyperlocal_daily_datatable.py:39-173` | `HYPERLOCAL_DAILY` | `Processing` → `COMPLETED` / `FAILED` |

The job creates the `report_exports` row as `Processing`, runs the same report read the screen uses (data
reader), writes the CSV to `S3_REPORT_EXPORT_FOLDER_PATH` (default `uploads/reports`, legacy
`create_and_upload_csv`, `helpers/helpers.py:2130-2183`), and stores the size as truncated KB and the row
count without the header (`helpers.py:2149`). Jobs without a legacy failure branch leave the row in
`Processing` on error, as legacy does.

3. `GET /api/v1/report-exports` and `POST /api/v1/report-exports/search` list `report_exports`;
   `GET /api/v1/report-exports/:exportId/file` streams the file.

## Deliberate differences (security)

- The list shows internal superadmins (role 1, user type 1) every row and everyone else only their own; legacy
  `export_datatable.py:33` lists every row to every user.
- Files are streamed through the API to the requester or an internal superadmin, only for keys under the
  configured prefix; legacy hands out presigned URLs to anyone.
- CSV cells keep the UTF-8 BOM and formula escaping.

| Case | Legacy | Rewrite |
|---|---|---|
| Export queued | queued-export text | same text, 200 |
| E3 with no visible store | `{"status":400,"message":"Pick at least one store to export."}` | 400 `EXPORT_STORES_REQUIRED`, same text |
| Download of another user's file | presigned URL | 403 `EXPORT_ACCESS_DENIED` |
| File not ready | no URL | 409 `EXPORT_NOT_READY` |

## Configuration

`AWS_STORAGE_BUCKET_NAME` (private bucket, Block Public Access required), `AWS_S3_REGION_NAME`,
optional `AWS_S3_ENDPOINT_URL`, `AWS_S3_KMS_KEY_ID`, `AWS_S3_EXPECTED_BUCKET_OWNER`,
`S3_REPORT_EXPORT_FOLDER_PATH` (default `uploads/reports`) and `REPORT_EXPORT_MAX_BYTES` (64 MiB). Jobs run in
`npm run worker:jobs` with `REDIS_URL`.

## Evidence and limits

`tests/operational-reports/export-mysql.integration.test.ts` runs E1–E6 on isolated MySQL with fake storage.
Live S3 and a deployed `worker:jobs` are not exercised. This is implementation, not parity certification.
