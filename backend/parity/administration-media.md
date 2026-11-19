# Private documentation media

The guide editor/reader replace the pinned source's upload/edit, detail, lists and status capabilities. Isolated MySQL and Chromium checks use fake HTTP/storage boundaries; they do not certify live S3 permissions, production objects or complete source workflows.

## Deployment

No migration is needed (schema freeze). Root registration injects `createDocumentationMediaStore(config, readDocumentationMediaOptions())` and closes it on shutdown. Missing bucket/prefix leaves attachments unavailable. Demo mode never creates the real adapter.

| Setting | Purpose |
| --- | --- |
| `AWS_STORAGE_BUCKET_NAME` | Private bucket |
| `AWS_S3_REGION_NAME` / `AWS_REGION` | Bucket region; default `ap-south-1` |
| `S3_TUTORIAL_FOLDER_PATH` | Exact existing tutorial prefix |
| `AWS_S3_ENDPOINT_URL` | Optional approved HTTPS endpoint; local HTTP only outside production |
| `AWS_S3_KMS_KEY_ID` | Optional KMS key; otherwise uploads request AES256 |
| `AWS_S3_EXPECTED_BUCKET_OWNER` | Optional twelve-digit expected bucket owner; bound to readiness/read/delete requests |
| `AWS_S3_PRESIGNED_URL_EXPIRY` | Form expiry bound, additionally capped at 900 seconds |

New signed uploads first verify all four bucket-level Block Public Access flags and fail closed on absent/failed metadata. There is no success cache in the scoped upload adapter. Runtime credentials need `s3:GetBucketPublicAccessBlock`; optional expected-owner checks bind the account. Legacy reads remain separate. See the [S3 readiness API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetPublicAccessBlock.html). The SDK uses its default credential chain. Scope API GetObject/PutObject and worker DeleteObject to this prefix; confirm key-policy permissions for checksum-enabled HEAD and encrypted reads before rollout. Keep the bucket private. Never log signed forms, keys, filenames, checksums, credentials or SDK errors.

Bucket CORS allows POST from exact `WEB_ORIGIN`. Electron loads HTTPS `POS_DESKTOP_URL`; add that exact origin only if intentionally different and backend origin policy is aligned. No `null`, wildcard or `file://` origin is needed. Build-time `POS_MEDIA_ORIGINS` contains the exact trusted HTTPS upload origin for CSP. S3 POST sends no application cookies. Reads/downloads use authenticated same-origin streaming, including ranges, and require no external desktop navigation.

The [S3 POST API](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTObjectPOST.html) defines the checksum/encryption fields. Validate policy enforcement, CORS and private access in an isolated bucket before enabling real uploads.

## Lifecycle (schema freeze, W8a)

- Pending uploads: Redis `pos:doc_upload:{assetId}` → JSON `{id, objectKey, actorId, kind, name,
  contentType, size, checksum, state PENDING|READY, expiresAt}`, EX 3600, `SET NX`; at most 40 open
  per actor. Completion verifies the object and marks it READY (KEEPTTL).
- Save attaches READY uploads by writing their keys into the `pos_tutorial` list columns (legacy
  shape) and deletes the Redis reservations after commit.
- Optimistic version = `pos_tutorial.updated_at` (`expectedVersion` is that string; `''` for a new
  guide). It has 1-second precision, so two saves in the same second are last-write-wins, as
  legacy is.
- Save replays: `pos:idem:documentation:{operationId}` → JSON `{actorId, requestHash, documentId,
  version, created}`, EX 86400, written after commit.
- Removed attachments are deleted from S3 synchronously after commit (legacy `storage.delete`,
  `core/views.py:2521-2522`); a failed delete emits the registered event
  `administration.documentation-media.delete-failed` (ids only). Cancelling a pending upload deletes
  its object.
- Uploaded keys keep the original file name: `{dir}/{sanitised name}_{assetId}.{ext}`; the reader
  shows the name without the id suffix. Attachment ids are derived from the stored key.
- `worker:documentation-media` (`media-worker*.ts`, `media-cleanup.ts`, `media-schema.ts`) and the
  `pos_rewrite_documentation_assets/_revisions/_mutations` tables are removed / no longer used.
- Writers hold `pos:lock:admin:documentation`.

Validation differences kept: JPEG/PNG/WebP/GIF images ≤10 MiB, MP4/WebM videos ≤100 MiB,
PDF/Office Open XML ≤25 MiB, plain text ≤5 MiB. Legacy generated a title PNG cover on every save;
the rewrite shows a live title card plus an optional uploaded cover (visual redesign, open item).
Abandoned reservations (object uploaded, never saved) need an S3 lifecycle rule on the
`_<uuid>` keys of the tutorial prefix.
