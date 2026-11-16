# Private documentation media

The guide editor/reader replace the pinned source's upload/edit, detail, lists and status capabilities. Isolated MySQL and Chromium checks use fake HTTP/storage boundaries; they do not certify live S3 permissions, production objects or complete source workflows.

## Deployment

Apply `src/modules/administration/migration.sql`, then `src/modules/administration/media-migration.sql` through the writer-only runner. Only rewrite-owned tables/registry rows are created. Root registration injects `createDocumentationMediaStore(config, readDocumentationMediaOptions())` and closes it on shutdown. Missing bucket/prefix leaves attachments unavailable. Demo mode never creates the real adapter.

| Setting | Purpose |
| --- | --- |
| `AWS_STORAGE_BUCKET_NAME` | Private bucket |
| `AWS_S3_REGION_NAME` / `AWS_REGION` | Bucket region; default `ap-south-1` |
| `S3_TUTORIAL_FOLDER_PATH` | Exact existing tutorial prefix |
| `AWS_S3_ENDPOINT_URL` | Optional approved HTTPS endpoint; local HTTP only outside production |
| `AWS_S3_KMS_KEY_ID` | Optional KMS key; otherwise uploads request AES256 |
| `AWS_S3_EXPECTED_BUCKET_OWNER` | Optional twelve-digit expected bucket owner; bound to readiness/read/delete requests |
| `AWS_S3_PRESIGNED_URL_EXPIRY` | Form expiry bound, additionally capped at 900 seconds |
| `DOCUMENTATION_MEDIA_WORKER_ENABLED` | Defaults to `false` |
| `DOCUMENTATION_MEDIA_WORKER_INTERVAL_MS` | Default 30000; bounds 1000–60000 |
| `DOCUMENTATION_MEDIA_WORKER_BATCH_SIZE` | Default 5; bounds 1–25 |

New signed uploads first verify all four bucket-level Block Public Access flags and fail closed on absent/failed metadata. There is no success cache in the scoped upload adapter. Runtime credentials need `s3:GetBucketPublicAccessBlock`; optional expected-owner checks bind the account. Legacy reads remain separate. See the [S3 readiness API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetPublicAccessBlock.html). The SDK uses its default credential chain. Scope API GetObject/PutObject and worker DeleteObject to this prefix; confirm key-policy permissions for checksum-enabled HEAD and encrypted reads before rollout. Keep the bucket private. Never log signed forms, keys, filenames, checksums, credentials or SDK errors.

Bucket CORS allows POST from exact `WEB_ORIGIN`. Electron loads HTTPS `POS_DESKTOP_URL`; add that exact origin only if intentionally different and backend origin policy is aligned. No `null`, wildcard or `file://` origin is needed. Build-time `POS_MEDIA_ORIGINS` contains the exact trusted HTTPS upload origin for CSP. S3 POST sends no application cookies. Reads/downloads use authenticated same-origin streaming, including ranges, and require no external desktop navigation.

The [S3 POST API](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTObjectPOST.html) defines the checksum/encryption fields. Validate policy enforcement, CORS and private access in an isolated bucket before enabling real uploads.

## Lifecycle

Browser SHA256 precedes a UUID reservation binding exact size, type, checksum, actor and one-hour lease. The signed POST is shorter-lived and encrypted. Completion verifies HEAD size/type/SHA256 plus a small byte signature. A writer transaction rechecks current administrative privilege and atomically attaches owned READY uploads with the guide, version and replay record. Expected-version conflicts reject stale editors. Archive/status changes also advance the version.

Lists preserve source descending `sort_value`, with a stable ID tie/cursor. Asset/version/uploader reads are batched. Sanitized descriptions render inside an empty-sandbox iframe with restrictive CSP. Keys use generated names under source cover/image/video/document directories. Legacy JSON/Python-repr arrays are parsed without evaluation; invalid metadata fails closed. Attachment access re-reads current guide state on the writer to prevent replica revocation lag.

Uploads accept JPEG/PNG/WebP/GIF images up to 10 MiB, MP4/WebM videos up to 100 MiB, PDF/Office Open XML documents up to 25 MiB, and plain text up to 5 MiB. Source UI had broader image/video selection, PDF-only documents and no server size bound. These are explicit validation changes. Unsupported legacy files remain forced downloads. Source automatic title-to-PNG generation becomes a live title card plus optional uploaded cover; this is visual redesign, not bitmap parity.

## Cleanup/recovery

Run `npm run worker:documentation-media` under supervision. It polls bounded batches without overlap, uses `FOR UPDATE SKIP LOCKED`, aborts each batch after 20 seconds and handles SIGTERM/SIGINT with bounded shutdown. Disabled execution makes no storage request.

Unattached PENDING/READY uploads and removed DELETE_PENDING files become eligible after their lease plus fifteen-minute grace. Attached files are excluded. Generated never-attached orphans need no legacy reference scan. Removed/legacy files receive an exact shared-reference scan over bounded PK pages; shared files become RETAINED. Invalid metadata or more than 10000 guides prevents deletion and requires review. A verified normalized reference backfill should eventually replace this scan.

Failures persist attempts; the tenth becomes BLOCKED. Events contain only module/resource/event/effect/document/request/user identifiers and static codes. Blocked rows are re-alerted after restart. After repairing permissions/scope/references, requeue one UUID:

```sh
npm run worker:documentation-media -- --retry-asset ASSET_UUID
```

Recovery resets a pending/blocked counter, makes no immediate delete, and cannot requeue attached/retained/deleted assets. Audit shared objects explicitly before any bucket lifecycle cleanup. Existing source writers need coordinated rollout because they do not maintain rewrite versions/media state.
