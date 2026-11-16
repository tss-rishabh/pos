# Durable report export migration evidence

Source baseline: `backend-pos-web` commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. Source contracts: `report/models.py:ReportExport`, `report/datatables/export_datatable.py`, `helpers/helpers.py:create_and_upload_csv` and `helpers/storage.py`.

The operational-reports plugin adds six routes: create/list/read at `/api/v1/report-exports`, private filtered metadata search at `/search`, protected file streaming at `/:exportId/file`, and legacy file streaming at `/legacy/:exportId/file`. Apply `src/modules/operational-reports/migration.sql` to create `pos_rewrite_report_exports`. Frontend export: `ReportExportsPage({user,storeId})` from `frontend/src/pages/operational-reports/exports.tsx`. Registration/start/stop are owned by `registerOperationalReports`.

The finite builder supports complete filtered day-close history (28 columns), store cash balances (11 columns), returned orders (12 columns), combined store/online order transactions (75 columns), hyperlocal daily reports (17 columns) and flash sales (22 columns), reusing their report services and reader policy. Optional validated report names and notes are immutable command inputs. Scheduled hyperlocal/CRM delivery groups are implemented separately in `scheduled-reports.md`. Signed monetary values remain numeric and untrusted spreadsheet formulas, including control/format-character prefixes, are escaped. A UTF-8 BOM and formula escaping intentionally differ from the legacy generic CSV writer's raw bytes.

## Authorization and lifecycle

Creation requires an immutable command UUID, strict kind-specific input and signed-in operator header. Concurrent retries yield one job; changed filters under that command are rejected. The queue snapshots selected/assigned store IDs, original user type, requester and request ID. Global exports require current superadmin throughout. Account, role, user type and assignments are read from the writer before queueing, building and downloading. Report contents never authorize financial operations. Today's report data uses the data reader; historical/mixed ranges use configured BigQuery views without a MySQL history fallback. Queue/receipt/file authorization is authoritative operational state, regardless of file age.

Workers claim using `FOR UPDATE SKIP LOCKED`, process at most three jobs per pass and hold no SQL transaction during report queries or S3 calls. Before PUT, immutable key/checksum/size/count are saved as STORING. Conditional `If-None-Match: *` prevents overwrite. Lost upload responses are reconciled with HEAD and the saved checksum/size, without rebuilding changed report data or blindly repeating PUT. Missing/interrupted artifacts fail; uncertain HEAD results receive at most three recovery attempts. BUILDING leases expire after 120 seconds. A new explicit request after failure creates a new artifact. Worker events contain static status/error codes, module/resource/event ID, unique event instance, original request/user ID and opaque export ID. Filters, CSV contents, raw errors, object keys and URLs are never logged.

Legacy `report_exports` is read-only. Non-superadmins see only their own requests; source global disclosure is not retained. Raw legacy message/error strings are replaced with static status text. Failed jobs terminate polling correctly. Existing rows lack a stored file store scope, so legacy downloads require writer-current role 1, internal user type 1 and CSV format. This security correction denies franchise superadmins and stale principals access to unmasked files with unverifiable scope. New files use a separate rewrite-owned table, preventing the old unscoped legacy endpoint from exposing them during coexistence. No new legacy rows or public/presigned URLs are created. HTTP legacy URLs and objects outside the approved prefix are rejected.

Recent metadata includes all pending jobs regardless of age plus terminal jobs from the preceding 24 hours. Older completed/failed metadata requires explicitly configured BigQuery views, without a MySQL historical fallback. Current actor names may be batched from the primary reader. Receipt, artifact eligibility and file authorization always use writer-current state. Compatible-view contracts and time boundaries are in `export-history.md`.

Private storage reuses administration's bounded S3 client, shared `assertPrivateBucket` guard and default role/profile credential chain. All four bucket Block Public Access flags must be enabled before every storage operation. Simultaneous checks may share an in-flight promise, and successful results are not cached indefinitely. Uploads use SSE-S3 or the configured KMS key, SHA-256 checksums, no ACL and opaque UUID file names. Downloads use authenticated `private, no-store` streams, ETag preconditions when available, bounded size/time, full-content checksum validation for new files, sanitized stream errors and abort cleanup. The implementation follows AWS [conditional PUT semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html), [GET preconditions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html), and [S3 security guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html).

## Runtime configuration

All options are validated in `export-storage.ts`; no live bucket, role or object has been created by implementation/tests.

| Option | Default / requirement |
|---|---|
| `AWS_STORAGE_BUCKET_NAME` | Existing private bucket required |
| `AWS_S3_REGION_NAME` / `AWS_REGION` | `ap-south-1` |
| `AWS_S3_ENDPOINT_URL` | Optional credential/query/hash-free HTTPS endpoint; local HTTP only outside production |
| `AWS_S3_KMS_KEY_ID` | Optional, otherwise SSE-S3 |
| `AWS_S3_EXPECTED_BUCKET_OWNER` | Optional 12-digit account ID; recommended for account-bound access |
| `S3_REPORT_EXPORT_FOLDER_PATH` | `uploads/reports/pos-rewrite`; new job UUID files |
| `S3_LEGACY_REPORT_EXPORT_FOLDER_PATH` | `uploads/reports`; read-only legacy files |
| `REPORT_EXPORT_WORKER_ENABLED` | `false`; `true` starts the plugin worker outside demo |
| `REPORT_EXPORT_WORKER_INTERVAL_MS` | `3000`, range 1000–60000 |
| `REPORT_EXPORT_MAX_PENDING_PER_USER` | `3`, range 1–10 |
| `REPORT_EXPORT_MAX_BYTES` | 64 MiB, maximum 256 MiB; maximum 70,000 data rows |

Use a role scoped to the configured report prefixes and required bucket privacy checks, plus applicable KMS permissions; never put static credentials in source/client options. Bucket privacy/encryption, role permissions and BigQuery mappings require deployment verification. Storage, PUT/GET requests and optional KMS operations incur costs. Configure business-approved object/metadata retention, S3 access or CloudTrail data-event auditing with retention, and CloudWatch storage/request/error monitoring. Opaque keys avoid customer names in audit trails. Lifecycle deletion makes old downloads unavailable safely. Deployment shutdown must allow the bounded in-flight report/upload to finish; interrupted leases are recoverable.

## Evidence and limits

Nine isolated MySQL tests exercise concurrent command/worker claims, immutable filters, quota, legacy read-only behavior, scope/role/type/account revocation, old pending state, archive file eligibility, interrupted builds and lost PUT reconciliation. Four SDK middleware tests make zero network requests and verify privacy flags, encryption, conditional upload, prefix denial, changed metadata/content and sanitized stream errors. Two worker tests check no overlap, request/user tracing and safe error fields. Frontend tests retain operator-scoped retry IDs without persisting report search text. Separate source-oracle/SQL tests substantiate each builder's rows. Archive reader tests verify bound date/owner/search filters and missing-view failure. An isolated Chromium protocol fixture verifies named export creation, archive filters, sorting, actor labels and authenticated download, plus cash-ledger pagination, smart search, filtered CSV and named full exports. It passes thirteen UI/protocol checks with zero real business service calls; evidence is in `evidence/operational-reports/export-archive.{json,png}` and `cash-ledger-controls.png`. This is source-derived and deterministic fixture evidence; no full legacy byte parity, live S3 delivery or production-data certification is claimed.
