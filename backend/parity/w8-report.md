# W8 report: job queue, administration, reports and finance

Branch `w8/admin-reports-jobs` from `1a651f9`. Legacy citations are `backend-pos-web@78d5b63`. Nothing was run
against production or live services. This is implementation, not parity certification.

## 1. Job queue (`backend/src/jobs/**`, phase-c-legacy-jobs.md §4)

Replaces legacy Celery (`Dockerfile.celery:64`, `POSAdmin/celery.py:1-8`, `POSAdmin/settings.py:417-431`).
`contract.ts` is unchanged.

| File | Role |
|---|---|
| `redis.ts` | node-redis transport: `send(args)` and `evalScript` (EVALSHA, EVAL on NOSCRIPT). Loopback-only plaintext, TLS elsewhere. Redis errors become a fixed `REDIS_UNAVAILABLE` AppError (error text can carry credentials). |
| `queue.ts` | Producer (`redisJobProducer`), Lua scripts, store (`promote`, `finish`, `heartbeat`, `retire`, `listOrphans`, `listFailed`, `requeue`) and `jobClaimer` (LMOVE pass over all queues, round-robin start, then one 0.25 s BLMOVE). |
| `worker.ts` | Promoter loop (1 s), heartbeat (10 s, EX 30), claim loop feeding `JOBS_CONCURRENCY` slots (default 2). At-most-once: state `started` is written before the handler; failures go to `failed` with an error code, never retried. Handlers run under `withRequestTrace` with the job's requestId/userId (module `jobs`, resource `job`). `stop()` stops claiming, waits for in-flight jobs, deletes the heartbeat and the empty inflight list; `abort()` signals handlers (second SIGTERM). |
| `worker-main.ts` | `npm run worker:jobs` (consumes all seven queues), `--list-orphans`, `--list-failed`, `--requeue <jobId>`. The list and requeue commands print the at-most-once safety warning. |
| `registry.ts`, `handlers.ts`, `runtime.ts` | One handler table; `handlers.ts` is the single list of `src/modules/<m>/jobs.ts` `registerJobHandlers` imports, with marked placeholders for W4 `checkout` and W5 `legacy-fulfillment`, `legacy-order-status`, `order-history`. |
| `ephemeral.ts` | `EphemeralStore` port (GET/SET NX EX PX/DEL/compare-and-delete Lua/EXPIRE/TTL/INCR/LPUSH/LREM/LRANGE/SCAN) with Redis and in-memory implementations, plus `withEphemeralLock`. |
| `module-runtime.ts` | `createModuleRuntime(config)` used once in `app.ts`: Redis-backed when `REDIS_URL` is set; production without Redis fails closed (503); dev/test get in-memory state and a producer that refuses to enqueue. `recordingJobProducer` for tests. |

Design notes:
- Every multi-key step is a single Lua script (atomic like the §4.4 MULTI blocks).
- Records are serialised with `id` and `state` first, so promotion and requeue change the state with
  an anchored Lua pattern instead of cjson re-encoding, which would rewrite large numbers.
- Delayed-job records live `7 d + delay`, so a long countdown cannot expire before it is due.
- Requeue checks the expected state in Lua and, for orphans, that the worker heartbeat is absent and
  the id was still in its inflight list, so a job cannot be requeued twice.
- The Lua promote/requeue scripts touch job keys that are not declared in `KEYS`. This is fine on standalone
  Redis (production uses `redis_instance`, db 0) but not Redis Cluster.

Tests: `tests/jobs/queue.redis.test.ts` covers 10 cases against a private loopback `redis-server`
(`tests/helpers/private-redis.ts`):
- enqueue with TTL and trace
- validation
- countdown promotion
- racing promoters
- round-robin claim
- success, failure and missing-handler paths with the restored trace and no args in logs
- concurrency cap and graceful stop
- orphan listing and requeue
- failed requeue
- parity between the Redis and in-memory ephemeral stores

### Redis keys (jobs)

| Key | Type | TTL | Value |
|---|---|---|---|
| `pos:jobs:q:{queue}` | LIST | none | job ids |
| `pos:jobs:delayed` | ZSET | none | job id → due epoch ms |
| `pos:jobs:job:{jobId}` | STRING | 7 d (+ delay), refreshed on each state change | JSON `{id,state,name,queue,args:[],kwargs,enqueuedAt,dueAt,requestId,userId,startedAt,finishedAt,workerId,errorCode}` |
| `pos:jobs:inflight:{workerId}` | LIST | none; deleted on graceful exit | claimed job ids |
| `pos:jobs:worker:{workerId}` | STRING | 30 s | heartbeat epoch ms |
| `pos:jobs:failed` | LIST | none, LTRIM 10 000 | failed job ids |


## 2. Module work

The work was split into four sub-branches with exclusive file ownership, then merged with `--no-ff` into
`w8/admin-reports-jobs`. The branches are kept; their worktrees are removed.

| Branch | Commits |
|---|---|
| lead | `91e709f` queue/worker/ephemeral port; `018436c` Redis admin lock; `75a54e1` lock cleanup; `279ea84` integration fixes |
| `w8/w8a-admin-core` | `77bae3a` `834d051` `340b076` `d2ea8d4` `1f3b940` `12e4f08` `eacf6d6` `896a4bb` `ef53add` `86db339` |
| `w8/w8b-admin-inventory` | `8d28725` `11bbbc7` `033d144` `e2d87cb` `91ecac5` `49d81d1` `4dbb0ce` `7a2653b` |
| `w8/w8c-reports-finance` | `0a3974a` `9aff572` `87fb80f` |
| `w8/w8d-giftcards-catalog` | `9060381` `1f162d0` `1cab0c7` `e235e71` `994356f` `c59c11d` `ea969ff` |

### 2.1 Jobs implemented (handlers in `src/modules/<m>/jobs.ts`)

| Job | Queue | Producer | Legacy |
|---|---|---|---|
| C1 `core.tasks.parse_csv_product_store` | `core` | inventory upload route, after commit | `core/views.py:122-142`, `core/tasks.py:28-37`, `helpers/task_helpers.py:64-173` |
| C2 `core.tasks.parse_csv_product_stock` | `core` | stock upload route, after commit | `core/views.py:374-397`, `core/tasks.py:39-48`, `helpers/task_helpers.py:175-350` |
| C10 `core.tasks.sync_ecom_inventory` | `core` | e-commerce settings `run_sync` | `core/views.py:2166-2167`, `core/tasks.py:181-206` (`pos_stock_syncer_bk` with bound values, then `GET MAIN_API_V2_URL syncproduct`; replaces the deleted `ECOMMERCE_FULL_SYNC_URL` bridge, the w2-followups item) |
| E1–E3, E5, E6 `report.datatables.*` | `export_queue` | `POST /api/v1/report-exports` | `report/datatables/*.py` (§2.6), `helpers/helpers.py:2084-2183` |
| E4 `report.datatables.sales_data.do_sales_export` | `sales_queue` | same | `sales_data.py:65-145` (`report_type` `RETURN` as legacy) |
| `pos.gift_card_batches.generate` | `core` | gift-card create route, after commit | `core/views.py:2186-2210`, `core/tasks.py:208-223`, `helpers/helpers.py:1265-1371` (approved divergence: queued, not inline) |

Details:
- **C1/C2:** each CSV record commits in its own transaction and then advances the Redis cursor
  `pos:import_progress:{id}`. If the cursor is missing on a resumed run, the upload is closed with a message and
  not re-applied (ledger high-risk note).
- **Exports:** the job itself creates the `report_exports` row as `Processing` and writes the legacy status
  casing per task (`COMPLETED` for E1/E2/E4/E6, `Completed` for E3/E5). `FAILED` is written only where legacy
  has a failure branch (E3/E5/E6). Size is truncated KB. The row count excludes the header because legacy
  `len(rows)` does (`helpers.py:2149`).
- **Gift cards:** Hashids/PIN CSV, a ZipCrypto zip with the legacy derived password (last 6 phone digits + id,
  default `123456` + id), upload, Netcore mail, then `gift_card_collection.filename`, `is_completed=1` and
  `message`.

### 2.2 Rewrite-only workers and loops removed (§5)

| Removed | Replacement |
|---|---|
| `worker:administration` (product-sync outbox) | `Helpers.sync_pos_product` inline after commit, failures logged (`helpers/helpers.py:192-202`; `core/views.py:489,543,564,776`) |
| `worker:settings` | effects inline after commit (`core/views.py:2020-2167`): common-Redis SETs, Slack notices, legacy cooldown `ecom_delivery_{store}` SET NX EX; e-commerce part is C10 |
| `worker:documentation-media` | replaced guide objects deleted synchronously after commit (`core/views.py:2521-2522`) |
| `worker:store-images` | removed; legacy never deletes replaced store images |
| `worker:profile-media` | script only (code is W3's and already deleted on `w3/auth-rehome`) |
| `worker:gift-card-batches` | `pos.gift_card_batches.generate` in `worker:jobs` |
| in-process report-export loop, lease/heartbeat, `operational-reports/job-worker.ts` | E1–E6 |
| in-process scheduled-report loop + delivery reconciliation routes | synchronous `POST /api/v1/report-deliveries` authenticated by the `apikey` header, Slack posted inline (§2.8, `report/views.py:810-1876`) |
| in-process catalog-maintenance worker | troubleshoot (`core/views.py:2987-3030`) and inventory pull (`:1564-1620`) synchronous in the request |
| CSV product upload parsing in the API | jobs C1/C2 |
| finance pending-close alert via the fulfillment outbox | Slack posted synchronously per store (`report/views.py:2557-2581`) |

The remaining `package.json` worker scripts are `worker:jobs`, plus these, kept until their owners remove the code:
- `worker:financial-outbox` (W4)
- `worker:customer-contacts` (W5)
- `worker:customer-otp` (W4/W5)
- `worker:security` (W3 has deleted its code on `w3/auth-rehome`)

### 2.3 Rewrite-only exports deleted (user decision 19 Nov)

- The current-inventory workbook: the whole `inventory-workbooks` module, `tools/inventory-workbooks`, and its tests
  and goldens.
- The `salesperson-performance`, `cashier-performance` and `hyperlocal-acceptance` export kinds.

The three on-screen reports stay because legacy has them (`report/urls.py:36-37,51-54`). They keep only the
legacy client-side CSV of the loaded page.

### 2.4 Admin forms and routes (phase-d S1–S25, C-rows, F1–F15)

The store, location-code, counter and storage forms follow `stores/forms.py`, `stores/views.py` and `_form.html`:
- Django field cleaning and per-field legacy messages, returned as `fields:{name:[...]}` (F1).
- Latitude, longitude and country are required, with no `0` prefill (F2).
- Franchise fields are optional, and the "associate existing" mode is removed (F5).
- The store image is chosen in the same form (F6).
- Blank email is stored as `''` (F7).
- City and state are read-only, `state_id` is hidden, and the PIN is looked up automatically at 6 digits (F8).
- Edit writes `city_id` 1111, as legacy does (F9).
- Counters and storages accept only active `type=STORE` stores, and a counter description is required (F10).
- The raw storage name may be up to 100 characters (F11).
- Labels, success texts and redirects are the legacy ones (F12).
- Negative thresholds are accepted (F14).

**`slack_group_url`:** any text up to 1000 characters, and the value is displayed. A blank create stores `''`
and a blank edit clears it to `''`. The Connect/Reconnect popup fills the field and the user must Save (F3,
S10, S11).

Lists and routes:
- **Store lists (S2/S3):** only `type=STORE`, with the legacy search fields.
- **Cross-store lists (S12–S14, S20–S22):** counters and storages have cross-store lists.
- **Store detail (S6):** lists EDC terminals.
- **Activation (S9):** the duplicate-name check is removed.
- **Messages:** the S5 and S18 messages are restored.
- **Storage move (F4):** removed.

**Check-ins (C13/C14):** use the legacy keys. Closed stores can be checked into (`helpers.py:778-824`), and the
legacy messages are returned.

Other rows:

| Rows | Change | Legacy |
|---|---|---|
| C5 barcodes | roles 1–3 of any user type | `core/views.py:1245-1282` |
| C10 catalogue snapshot | takes the last exclusive price | `core/views.py:1647-1719` |
| C1 counter product DTO | adds `holdedStock` / `storageStock` | `store_products_datatable.py:268-312` |
| C28 troubleshoot | any signed-in operator, constant 200 message | — |
| C24–C27, C33, C34 application links | Redis state; `GET /user_to_app?store_id=` served for printed QR codes | — |

## 3. `pos_rewrite_*` tables freed

The code no longer reads or writes 44 tables. The primary agent can drop their `migrations.ts` entries.

| Area | Tables |
|---|---|
| administration (W8a) | `operator_checkins`, `administration_registries`, `slack_connections`, `operator_mfa_enrollments`, `operator_mfa_mutations`, `documentation_assets`, `documentation_revisions`, `documentation_mutations`, `store_image_uploads`, `store_image_jobs` |
| administration (W8b) | `administration_outbox`, `inventory_imports`, `inventory_import_rows`, `parent_store_import_audits`, `settings_effects`, `settings_mutations`, `ecommerce_changes`, `ecommerce_inventory_syncs`, `ecommerce_inventory_sync_rows`, `barcode_assignments` |
| gift cards / application links / catalog (W8d) | `gift_card_batch_jobs`, `gift_card_batch_mutations`, `staff_download_grants`, `customer_application_links`, `customer_application_cache`, `application_scan_receipts`, `catalog_commands`, `catalog_deliveries`, `catalog_reconciliations`, `catalog_locks` |
| reports / finance (W8c) | `report_exports`, `scheduled_reports`, `scheduled_report_targets`, `scheduled_report_channels`, `finance_commands`, `finance_alert_commands` |

**SQL files kept, removable with their `migrations.ts` entries.** `migrations.ts` and `tests/migrations.test.ts`
read them, so they cannot be deleted yet:
- `administration/{migration,media-migration,mfa-migration,slack-migration,store-image-migration,settings-migration,import-migration}.sql`
- `administration/{parent-store-imports,ecommerce-sync,barcodes}/migration.sql`
- `gift-card-batches/migration.sql`, `application-links/migration.sql`, `catalog-details/maintenance-migration.sql`
- `operational-reports/{migration,scheduled-migration}.sql`, `finance/migration.sql`

**Compatibility exports still defining freed tables, kept for callers outside W8:**
- `administration/schema.ts` `operatorCheckIns`, used by W4/W5 tests.
- `administration/mfa-schema.ts` `operatorMfaEnrollments`, used by W3 `auth/revocation.ts`.
- `pruneSlackConnections`, `pruneOperatorMfaEnrollments` and `pruneApplicationLinks` are kept as no-ops for
  `worker:security`.

**Not freed (blocked):** the seven `pos_rewrite_administration_access_*` and group/permission tables. Their
targets `auth_group`, `auth_group_permissions`, `pos_user_groups` and `pos_user_user_permissions` are not in
`production-schema.json`, and `POS_PROD_RO_MYSQL_URL` was not set to capture their DDL. See N1.

## 4. Redis key families (besides the queue keys in §1)

| Key | TTL | Value |
|---|---|---|
| `check_in_{uid}` (legacy) | end of day − 1 s | `[store_id, "store_name"]` |
| `check_in_list_{store}` (legacy) | end of day − 1 s | LIST of user ids |
| `pos:checkin_counter:{uid}` | same | counter id |
| `ecom_delivery_{store}` (legacy) | `ECOM_DELIVERY_CHANGES_TIME` | `1`, SET NX |
| `dynamic_short_link_s_id_{store}` (legacy) | 3600 s | short link URL |
| `pos:slack_oauth:{sha256(state)}` | 600 s | `{userId, nonce, sessionBinding}`, single use |
| `pos:mfa_enroll:{opId}` | 10 min | attempts + auth-version binding |
| `pos:doc_upload:{id}` | 1 h | pending guide upload |
| `pos:store_image_upload:{id}` | 15 min | pending store image |
| `pos:import_progress:{uploadId}` | 7 d | `{record, failed, productIds, inserts}` |
| `pos:lock:import:{uploadId}` | 15 min, refreshed | token |
| `pos:lock:admin:{resource}` | 30 s lease | token |
| `pos:lock:catalog:barcode-mutations` | 30 s lease | token (barcode assignment and troubleshoot) |
| `pos:app_link_lease:{store}` | 15 s | token |
| `pos:staff_download:{grant,operator,activation,activated,consumed}:*` | QR period / `MPOS_DOWNLOAD_LINK_EXP` | grant JSON / operation id |
| `pos:idem:{mfa,documentation,settings,barcode,gift_card_batch,app_scan}:{op}` | 24 h (`app_scan` 1 h) | replay receipt JSON |
| `pos:finance_day_close_cmd:{operatorId}:{commandId}` | 7 d | `{requestHash, closeId}` |
| `pos:finance_day_close_alert_cmd:{commandId}` | 1 d | `{requestHash, result}` |

## 5. Shared-file edits

- **`backend/src/app.ts`:**
  - creates `const moduleRuntime = createModuleRuntime(config)` and closes it on shutdown;
  - passes `moduleRuntime`, or its `jobs`/`ephemeral`, to `registerAdministration`, barcodes,
    operational reports, catalog details, application links, gift-card batches and finance;
  - calls `useAdministrationEphemeralStore`;
  - wires the CSV storage and inline product-sync adapter;
  - removes the parent-store-imports, e-commerce-sync and settings-worker wiring.
- **`backend/package.json`:** adds `worker:jobs`; removes `worker:administration`, `worker:gift-card-batches`,
  `worker:documentation-media`, `worker:settings`, `worker:profile-media` and `worker:store-images`.
- **`backend/.env.example`:** adds `REDIS_URL`, `JOBS_CONCURRENCY`, `JOBS_PROMOTE_INTERVAL_MS`,
  `JOBS_HEARTBEAT_INTERVAL_MS`, `APP_APK_URL` and `MAIN_SITE_API_V2`. Removes the Slack OAuth gates,
  `STORE_IMAGE_WORKER_*`, `GIFT_CARD_*` worker keys, `POS_STAFF_APK_*`/`POS_CUSTOMER_APP_*`,
  `BQ_*REPORT_EXPORTS_VIEW`, `INVENTORY_WORKBOOK_*` and `ECOMMERCE_FULL_SYNC_*`.
- **`deployment.md`:** one `worker:jobs` paragraph replaces the administration, gift-card and settings worker
  paragraphs.
- **Tooling:** `backend/tools/container-fixture.cjs` drops the gift-card worker entry; `backend/tools/verify-project.ts`
  drops the inventory-workbook checks; `backend/tests/golden/INVENTORY.md` drops removed rows.
- **Not edited:** `src/db/legacy-schema.ts`, `src/config.ts`, `contract.ts`, `migrations.ts` and
  `rewrite-schema.ts`.

## 6. Caller fixes outside W8 ownership

- **`legacy-fulfillment/service.ts`:**
  - reads the check-in through `checkins.checkedInStore`;
  - reports `integrationState: 'unconfirmed'` because the outbox it read is gone.
- **`administration/collection-export.ts`:** `queueAdministrationCollectionExport` keeps its signature but now
  rejects with "Administration list exports are not available." See N4.
- **Check-in denial code:** stays `STORE_ACCESS_DENIED`, now with the legacy message "You are not assigned to
  this store", so the auth and fulfillment callers that match on it keep working.
- **New `tests/helpers/check-ins.ts`:** `seedCheckIn` and `clearCheckIn` write the legacy Redis keys through the
  process-wide store.

**Test owners must still switch from the old check-in table to this helper.** These suites seed or expire check-ins
through `pos_rewrite_operator_checkins`. They fail only with MySQL enabled:

| Suite | Owner | Failures |
|---|---|---|
| `tests/legacy-fulfillment/lifecycle.mysql.integration.test.ts` (via `lifecycle-fixture.ts`) | W5 | 20 |
| `tests/legacy-fulfillment/mysql.integration.test.ts` | W5 | 13 |
| `tests/fulfillment/mysql.integration.test.ts` | W5 | 2 |
| `tests/return-window/native.mysql.test.ts` | W4 | 1 |
| `tests/auth.mysql.integration.test.ts` | W3 | 1 (a check-in from an earlier test persists in the shared memory store; call `clearCheckIn`) |

Also W4: `tests/checkout/mysql.integration.test.ts` "cancels one pending zero-benefit order…" asserts a
`pos_rewrite_administration_outbox` row. Product sync is now inline after commit, so the assertion must change.
A later test in that file then fails as collateral, and passes when run alone.

Other files that still reference the old check-in table, and must switch the same way when they run:
- `tests/{checkout,customer-website-handoff,order-search,order-history/online-detail}/*`
- `tests/legacy-order-status/*`

Those suites already fail at `1a651f9` for other reasons.

### Verification

- Backend `tsc --noEmit`, `eslint .` and `orm-metadata` (0 mismatches) pass.
- Backend `vitest` without MySQL: 662 passed.
- Frontend `tsc`, `eslint .` and `vitest`: 265 passed.
- Backend `vitest` with all MySQL suites on an isolated MySQL 8.4 (empty `sql_mode`, loopback, now stopped):
  1255 passed, 44 failed. At base `1a651f9` the same environment fails 12 files; W8 fixes one of them
  (gift-card batches). The newly failing files are exactly the five above, plus the two extra checkout cases.
- The queue tests run against a private loopback `redis-server`.
- Not run: Playwright e2e/browser fixtures, a live `worker:jobs` against real services, S3, Netcore, Slack,
  API-v2 and Firebase. Nothing touched production.

## 7. Security decisions (for the primary agent to number S11+)

1. **Job args** carry ids and scalars only (validated, capped at 64 KB). Logs carry job/request/user ids, never
   args or results.
2. **Jobs are at-most-once.** Requeue is manual, single-shot, refused while the worker's heartbeat is alive, and
   prints the safety warning.
3. **Redis transport** errors are replaced by fixed codes, because Redis error text can carry credentials.
   Plaintext Redis is allowed only on loopback.
4. **The `apikey` header** of the scheduled-report endpoints is compared in constant time and accepted only as a
   header. A wrong key gets 401; legacy returned 200 `wrong api key`.
5. **Report-export list and download** are limited to the requester or an internal superadmin (legacy listed
   every export to every user). Files are streamed through the API only for keys under the configured prefix.
6. **Exported CSVs** keep the UTF-8 BOM and formula escaping.
7. **Slack calls** go only to HTTPS `hooks.slack.com` webhooks, with no redirects and escaped store names.
   The OAuth state is single-use and bound to the session.
8. **Gift cards:**
   - The weak derived archive password is user-mandated (AGENTS.md 19 Nov) and recorded as a known weakness.
   - The bucket must block public access, and SSE is requested.
   - Franchise users are denied generate, print and block.
9. **Application links:**
   - A staff QR is bound to the signed-in operator; legacy accepted any `user_id` and used an unsigned JWT.
   - Tokens are opaque, with one activation and one download.
   - The APK is served as an attachment with a sandbox CSP.
   - `/user_to_app` uses a bound-parameter insert (legacy built the SQL string), accepts only active stores, is
     rate-limited and redirects only to an allowlist.
10. **CSV imports:**
    - restricted to roles 1–3 with user type 1;
    - non-admins see only their own uploads;
    - capped at 256 KiB;
    - raw database errors are never stored in `failed_data`.
11. **Bound values and redirects:** C10 calls `pos_stock_syncer_bk` with bound values (legacy concatenated the
    SQL), and the `syncproduct` call refuses redirects.
12. **Admin authorization** keeps the store-scope and franchise checks on store edit (F13). Franchise users list
    only their franchise stores; legacy showed franchise role 1 every store. Store-list routes still require
    role 1–3.
13. **Store images** accept only JPEG, PNG, WebP and GIF up to 10 MB, through private signed upload.
14. **MFA enrollment** is invalidated when the actor's or the target's authentication changes.
15. **Locks:** Redis lease locks replace the row locks on the administration registries and catalog. Legacy had
    none. The barcode lock is the only duplicate-GTIN guard, because `products_gs1` has no unique index.

## 8. Remaining gaps

**Blocked or not done:**
- Access control (groups and permissions) stays on its rewrite tables (N1).
- The `administration_access_mutations` receipts are also still used by operator-admin and model-accounts.
- Administration list "export all" no longer works: it has no legacy job (N4).

**Behaviour that still differs from legacy:**
- Lists use cursor paging, not DataTables offset paging, and storage-form field errors show in one banner.
- Guide covers: legacy auto-generates a title cover on every save; the rewrite does not.
- The pending day-close alert still refuses a day whose close window is open (`DAY_CLOSE_WINDOW_ACTIVE`). Legacy
  has no such check (N5).
- Out of scope, listed: F15 (the Django admin Store ModelAdmin) and C2 (the combined special-permission page).
- The legacy `mpos-download-*` paths are not served. Their QR codes expire after 60 s, so nothing printed
  depends on them.

**Work for other workstreams and operations:**
- Checkout returns and cancellations and legacy-fulfillment (W4/W5) must call `productSynchronizer` after commit.
  `enqueueInventorySynchronization` now only records.
- The counter UI (W4 `counter.tsx`) does not yet show `holdedStock`/`storageStock` or a cashier troubleshoot
  button.
- Firebase Dynamic Links shut down on 2025-08-25, so `firebase-dynamic-link` behaviour is unverified.
- `/user_to_app` needs a reverse-proxy route on the legacy host.
- Uploads that are never saved need an S3 lifecycle rule.

**Stale references:**
- `.github/workflows/desktop-platforms.yml` and `tools/parity/source-surface-families.json` still name deleted
  inventory-workbook and import tests.
- The parity notes `report-exports.md`, `scheduled-reports.md`, `finance.md`, `export-history.md` and
  `inventory-workbooks.md` are stale. Their legacy-vs-new message table:

| Case | Legacy | Rewrite |
|---|---|---|
| Export queued | queued-export text | same text, 200 |
| E3 with no visible store | `{"status":400,"message":"Pick at least one store to export."}` | 400 `EXPORT_STORES_REQUIRED`, same text |
| Wrong report API key | 200 `{"status":"failed","message":"wrong api key"}` | 401 `SERVICE_AUTHENTICATION_REQUIRED` |
| Download of another user's file | presigned URL to anyone | 403 `EXPORT_ACCESS_DENIED` |
| File not ready | no URL | 409 `EXPORT_NOT_READY` |

**Missing tests and unverified paths:**
- No browser test exists yet for the new store form. The gift-card Chromium test was deleted and not replaced.
- The stock procedures `pos_stock_syncer` / `pos_stock_syncer_bk` are not verified against production.
- No live run of `worker:jobs`, ZipCrypto archives, Netcore, S3 or Slack.
- Production readiness is not claimed; the release gate must stay failing.

## 9. NEEDS USER DECISION

- **N1. Access control.** Re-home groups and permissions to the Django auth tables, which needs their DDL
  captured read-only, or keep them on the rewrite tables.
- **N2. CSV `IsHold=0`.** Legacy CSV `IsHold=0` still holds stock, so the CSV can never unhold. The rewrite had
  fixed this; W8 restored the legacy behaviour as instructed. Confirm.
- **N3. Product-store CSV upload.** Its legacy URL is commented out (`core/urls.py:11`). Keep the page or delete
  it?
- **N4. Administration list "export all".** Legacy has no such export job. Delete it, or replace it with what?
- **N5. Day-close alert window check.** Drop the extra open-window check on the pending day-close alert to match
  legacy?
- **N6. Franchise role-1 store visibility.** Legacy shows franchise role-1 users every store; the rewrite limits
  them to their franchise.
- **N7. Gift-card list search.** Legacy raises `FieldError` on any search; the rewrite searches id, size and
  message.
