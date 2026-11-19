# POS Rewrite — Single-stack, schema-frozen, 1:1 legacy parity completion

## Status — W18, 19 November 2026

Branch `refactor/single-stack-schema-freeze`. Phases A–E are integrated (merge `8a7530aa`), and the Phase F local
verification ran on the same product code (W18 heads `f600dd54` and `a2382b4e` change only tests and tooling). The full matrix is in `backend/parity/w18-verification.md`. Where this plan
and `AGENTS.md` differ, `AGENTS.md` wins: Google SSO was dropped, the offline limits moved to env, and the offline
reference became a `comments` row rather than `orders.order_ref_no`.

| Phase | State | Evidence |
|---|---|---|
| A. Golden capture, schema snapshot | Done (W1, W15 recapture; 119-table snapshot `30983aa3`) | `backend/tests/golden/**`, `w15-report.md` |
| B. Ledger and removals | Done: 226 `pos_rewrite_*` tables (136 deleted, 30 to production tables, 60 to Redis, 0 without a home); migrations, review SQL, screening, compatibility, cash-return intents, demo mode, CSV import and SSO deleted; no `.py/.go/.php` | `table-disposition.md`, `w2-followups.md`, `w9-report.md`, `w10-report.md` |
| C. Re-home state | Done: auth/sessions (W3), checkout (W4), orders (W5), admin/reports/finance and the Redis job queue (W8) | `w3`–`w8` reports |
| D. Remaining parity | Done for the decided scope, including S35 type-8/exchange guards and the checkout controls; open items in `source-surface-map.json` (9 remaining-code groups, several stale, see `w18-verification.md` §6) | `w4-report.md`, `w5-report.md` |
| D2. Offline billing | Done per the 19 November revisions; 12/12 Electron scenarios | `w17-report.md` |
| E. Standards | Done: ORM 0 mismatches, documented ORM exceptions, zod on 335/335 routes, tracing and redaction | `w11-report.md`, `w12-report.md`, `orm-exceptions.md` |
| F1. Live read-only suite | Done by the primary agent: run 4, 16/16 paths, schema 99/99 exact, 0 locks | `backend/evidence/live-readonly-2026-11-19-r4.json` |
| F2–F5. Local verification | Done on loopback, with the failures and flakes listed in `w18-verification.md` | `backend/evidence/verification-a2382b4e-single-stack.json` (run 2) and `verification-f600dd54-single-stack.json` (run 1) |
| F6. Docs | Done (W18): `HANDOFF.md`, `CHECKPOINT.md`, the source-surface map, `release-coverage.json`, `docs/pull-requests/*` | — |
| Release | **Not ready.** The release gate fails: 396 surfaces and 12 requirements still pending | `tools/parity-gate.ts` |

## Context
The rewrite (`/Users/rishabhbhatia/code/pos-rewrite`, `main` == `feature/order-copy-history-integration` == `e392040`)
must reach production-ready 1:1 parity with legacy Django `backend-pos-web@78d5b63` on Node 24 / TS / React /
Electron only, with zero new tables/columns/indexes, no Python/Go/PHP, no extra features, ORM-only queries,
strict validation, and request→method trace logging, verified against live read-only MySQL.

Phase 0 discovery found the current tree is far from those mandates:
- 102 registered migrations create **226 `pos_rewrite_*` tables** (none in production); Drizzle defines 303 tables
  (188 rewrite-owned, 115 production). 49 `*.review.sql` files propose ALTERs/triggers/indexes on production tables.
- **383 .py / 89 .go / 3 .php** files: legacy source oracles (~62 TS tests shell out), Go native fixtures in Docker,
  cross-service upstream patches, a Python customer-contacts service, and generators (`generate_orm.py`,
  `native-head-metadata/generate.py`). `worker:origin-history` spawns Python at runtime.
- Extra features: screening subsystem (SKU 390238, ~5 workers, ~80 env flags), cash-return intent protocol,
  demo mode, CSV import authority succession.
- Gaps: legacy flags unimplemented (`EXCHANGE_ENABLED_STORE_IDS`, `EXCHANGE_ENABLED_FOR_ALL_STORES`,
  `ENABLE_NEW/OLD_PG_DISCOUNT`, `GLOBAL_SHOW_COUPON_MODULE`, `GLOBAL_SHOW_PG_DISCOUNT_MODULE`,
  `ENABLE_WHATSAPP_INVOICE`, `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT`, `LOGIN_FIXED_OTP_ENABLED`,
  `MPOS_QR_SINGLE_DOWNLOAD`); prod_type 8 new-exchange guard absent; checkout control inventory incomplete;
  20 partial order routes. Raw SQL: 571 `sql\`` uses/125 files + 131 `.query/.execute`/52 files. `any`: 0.
- Live MySQL reader: `SELECT`-only grants on `tss`, `tss-one`, `mobile_cms`. Legacy keeps ephemeral state in Redis
  (OTP, verified-user/tab objects, cache), Celery broker, sessions in `django_session`, users in `auth_user`/`pos_user`.

## User decisions (2026-11-18/19)
1. **Strict schema freeze, legacy-style**: delete all 226 tables + all review DDL. Durable data only in existing
   production tables (synchronous writes as Django did); ephemeral/idempotency/locks/claims/sessions/jobs in Redis.
2. **Golden fixtures** replace oracles: run existing oracles one final time *outside the repo*, commit outputs as JSON;
   TS tests compare against them + live read-only production data. Zero Py/Go/PHP in repo.
3. **Delete screening + all `compatibility/upstream/**` + customer-contacts Python service**; call API-v2 `pos/order`
   exactly as legacy does (API-v2 keeps enforcing screening limits).
4. **Remove** cash-return intent protocol (restore legacy `AjaxPaymentStatusView` flow), demo mode, CSV import
   authority succession (keep "pause inconsistent CSV tenders for manager correction").

## Execution rules
- New branch `refactor/single-stack-schema-freeze` from `e392040`. Check `git worktree list` / other agent
  sessions before starting; coordinate shared files (`db/migrations.ts`, `app.ts`, `config.ts`, `legacy-schema.ts`).
- Per AGENTS.md: implement everything first with narrow targeted checks; full verification only at the end.
- Parallel agents allowed with exclusive file ownership per phase-workstream (listed below).
- Production MySQL creds only via env (`POS_PROD_RO_MYSQL_URL`), never written to disk/logs/evidence.
  Do not overwrite `backend/evidence/verification-caba871-r9.json` or other historical receipts.
- Stop and ask the user whenever a legacy behavior cannot be supported without schema changes.
- First action after approval: save the four user decisions to project memory and append them to `AGENTS.md`'s
  standing order so parallel agents/future sessions inherit them.
- Recommend the user rotate the read-only MySQL password after this work (it was shared in chat).

## Phase A — Capture before deletion (must precede any oracle removal)
1. **Golden fixture capture**: copy oracle runners to a scratch dir outside the repo; run every oracle case currently
   used by TS tests (inventory from `execFileSync('python3'` / `run*.sh` call sites and `tools/verify-project.ts`
   lines ~333, 620, 1334–1459) against pinned legacy `78d5b63` (Python 3.10, per r9 failure cause) and Go fixtures
   in pinned `golang:1.25.4`. Write outputs to `backend/tests/golden/<area>/<case>.json` with metadata
   (source commit, oracle name, input hash). No credentials/PII in fixtures — use synthetic inputs as today.
2. **Freeze generated TS**: `src/db/legacy-schema.ts` and `src/modules/screening-origins/native-head-metadata.generated.ts`
   become hand-maintained (the latter is deleted with screening). Replace `tests/orm-metadata.test.ts`'s
   `generate_orm.py` re-run with a TS test comparing Drizzle definitions against production `INFORMATION_SCHEMA`
   (Phase E) and a committed schema snapshot (`backend/tests/golden/schema/*.json`, captured read-only now).
3. **Production schema snapshot**: read-only `SHOW CREATE TABLE` for every production table Drizzle references
   (115 + any newly needed) into the committed snapshot (DDL only, no data).

## Phase B — Table disposition ledger + removals
1. Write `backend/parity/table-disposition.md`: for each of the 226 `pos_rewrite_*` tables → one of
   (a) delete with removed feature, (b) replaced by existing production table/column (name it, as legacy does),
   (c) replaced by Redis key family (name pattern + TTL, mirroring legacy Redis usage), (d) **NO HOME → ask user**.
   Expected Redis replacements: auth sessions & SSO/PKCE flows & login challenges & OTP (legacy `core/tasks.py:234`
   pattern), idempotency receipts, recovery claims, locks/mutexes, rate limits, job queues (BullMQ-style on existing
   redis dep, replacing outbox tables + 17 worker processes where legacy used Celery/threads).
   Expected production-table homes: operators → `pos_user`/`auth_user`; Google identity → `auth_user.email` match;
   TOTP secret → wherever legacy stores it; offline/CSV → `pos_csv_upload` and order tables; inventory → `pos_*_logs`.
   **Checkpoint: present all (d) rows to the user before Phase C.**
2. Delete: `backend/migrations/*.sql`, all registered migration SQL, `src/db/migrations.ts` + `migrate` scripts,
   all `*.review.sql`, DDL/trigger strings in TS writers, the 188 rewrite-owned Drizzle tables.
3. Delete features: screening (`modules/screening-origins/**`, `checkout/screening-writer/**`,
   `legacy-order-imports/{screening-counter,benefit-profile/history-generation*}`, `frontend/src/pages/screening-writer`,
   related workers/env/config/docs), cash-return intents (`checkout/payment-reversals` intent routes),
   demo mode (`auth/routes.ts:186`, `config.ts:47,134`), CSV authority succession
   (`legacy-order-imports/authority-succession/**`, related correction approval chains), `compatibility/**`
   (incl. customer-contacts service — re-home any legacy-reachable contact behavior onto legacy tables/Redis).
4. Delete all `.py/.go/.php`, `go.mod/go.sum`, `pyproject.toml`, `uv.lock`, `requirements*.txt`, `.venv`,
   `resources/auth/pyotp-*`, Python Dockerfile, `"inventory": "python3 …"` script. Port to TS only the tooling
   still needed: `build_source_surface_map.py` → `tools/parity/build-source-surface-map.ts` (reads legacy repo
   files as text), `check_business_metrics_reachability.py`, report SQL generator (or freeze its output).
5. Remove `verify-project.ts` stages that run Python/Go/Docker oracles; replace with golden-fixture test stages.

## Phase C — Re-home state (no new schema)
Implement the ledger: Redis-backed stores behind existing repository interfaces (reuse redis client in
`auth/device-handoff-store.ts`, `modules/fulfillment/notification-bus.ts`); synchronous writes to production
tables inside Drizzle transactions where legacy did so; a single Redis job queue worker replacing outbox workers,
matching legacy Celery task set (`core/tasks.py` 14, `order/tasks.py`, `report/tasks.py` 5, view thread jobs).
- Recovery claims (50e2129/871ee3f/9640c75): Redis key per `(store,order,line,claim)` with request hash,
  operator, counter, verification id; keep idempotency (`IDEMPOTENCY_CONFLICT`), actor/check-in validation,
  fresh customer-proof renewal; UI keeps "unknown" on 409.
- Auth: Google OIDC + PKCE state/verifier and sessions in Redis; operator resolution via `auth_user`/`pos_user`;
  revocation on archive/check-out via Redis session index per user.

## Phase D — Remaining parity work
1. Checkout: finish reachable-control inventory vs `create_order.html` (incl. 165–174, 450–547, 1601, 2583) using
   `/tmp/pos-checkout-*.txt` if still present (else regenerate in TS); verify `CartQuoteSummary.tsx` quoteDisplay,
   complementary removal via `PUT line-items/:productId` qty 0, cashback gated on `app.discountEligible`.
2. Exchange: narrow `prod_type === 8` guard on *new* exchange selection/eligibility with source reason; recovery/
   retry/adoption still allowed.
3. Implement legacy flags listed in Context with legacy semantics (`order/views.py:339,1566`, etc.).
4. Complete 20 partial order routes (`order/urls.py:8–39`), admin form parity (incl. `slack_group_url ''` on create),
   BigQuery historical detail projections (no MySQL fallback).
5. Checkout/order submission: call API-v2 `pos/order` with legacy payload shape (no screening header).

## Phase D2 — Offline billing on encrypted SQLite (user-requested addition, 2026-11-19)
Goal: during a power/internet outage, the desktop app keeps billing; sales are stored encrypted on the machine and
sync automatically when connectivity returns. Decisions: **desktop (Electron) only**; **cash + manually-entered
card/UPI reference** (standalone terminal); **provisional reference on receipt, real invoice number at sync**;
**no benefits offline or at sync** (no coupons, wallet, points, cashback).

1. **Storage (Electron main process)**: `better-sqlite3-multiple-ciphers` (SQLCipher/AES-256) at
   `app.getPath('userData')/offline-billing.db`. Random 256-bit per-device key, wrapped with Electron `safeStorage`
   (macOS Keychain / Windows DPAPI); key never reaches the renderer. Rebuild native module via electron-builder
   (`frontend/electron/before-pack.cjs`). Local tables (device-only; production schema freeze unaffected):
   catalog snapshot (products, barcodes, prices, cached stock), operator/store/counter cache, sales, sale lines,
   payments (mode, amount, card/UPI reference), sync queue, per-device sequence, conflicts.
2. **Renderer bridge**: add `frontend/electron/preload.cjs` + `contextBridge` (none exists today). IPC channels
   `offline:catalog:*`, `offline:sale:create|list|reprint`, `offline:sync:status|retry`, `offline:conflict:resolve`;
   every message zod-validated in main; each IPC call gets a requestId/traceId logged PII-free.
3. **Catalogue cache**: refreshed on login and periodically while online from existing catalogue endpoints, scoped
   to the operator's store; cached stock decremented locally per offline sale.
4. **Offline mode**: detected via `net.isOnline()` + `/health/ready` heartbeat; banner + auto-switch. Only an operator
   already checked in on that device can bill offline (no new logins offline — Google OIDC needs network); session
   expiry/revocation re-checked on reconnect.
5. **Sale + receipt**: provisional reference `OFF-<storeId>-<counterId>-<deviceShort>-<seq>` (≤55 chars), printed as
   "Provisional — final invoice issued on sync". Card/UPI require reference entry. Legacy cached pricing only.
5b. **Offline limits (configurable, whichever is hit first)**: default **2 hours** or **10 orders** per device.
   - Config: two rows in existing `tss_settings` (legacy key/value pattern, `stores/models.py:6`,
     read like `core/views.py:1953`): `platform='POS_OFFLINE_BILLING_MAX_MINUTES'` value `120`,
     `platform='POS_OFFLINE_BILLING_MAX_ORDERS'` value `10`. Editable in the existing general-settings admin
     screen; code defaults 120/10 if rows absent. Rows are inserted at deployment, not during verification.
   - Device caches the values (in encrypted SQLite) on every online contact; they can't be raised while offline.
   - Window: starts at the device's last successful server contact; order count = unsynced sales on the device
     (including `needs_manager` ones). Both reset only after every queued sale has synced.
   - Clock-tamper guard: elapsed time is tracked with a monotonic clock persisted every minute; if the wall clock
     goes backwards or the app restarts with an inconsistent clock, treat the window as expired.
   - On hitting a limit: new sales blocked with a clear message showing time/orders used; reprint and sync remain.
6. **Auto sync (main process)**: on reconnect and on a backoff timer, uploads queued sales oldest-first to a validated
   backend endpoint that creates the order through the normal order-creation path with
   `orders.order_ref_no = <provisional ref>` (legacy offline import uses this column, `helpers/task_helpers.py:577`).
   Idempotency: server looks up `order_ref_no` before creating (plus a short Redis lock), so retries never duplicate.
   Server returns real order/invoice number → stored locally → receipt reprint available.
7. **Conflicts** (stock shortfall, price changed, card/UPI ref not found in `pos_paytm_transactions`/
   `pos_terminal_transactions`, operator revoked): sale stays in device SQLite as `needs_manager`; manager resolves
   on that device's Sync screen (accept / correct tender / void with reason), then it syncs. No server-side conflict
   table. Goods-already-sold sales are never silently dropped.
8. **Replace** the IndexedDB offline cash store (`frontend/src/offline/cash`, `fast-cash`, related Dexie tables in
   `frontend/src/offline/database.ts`) and the backend `modules/checkout/offline-cash/**` import-proof/signing
   machinery that writes `pos_rewrite_*` tables. Keep IndexedDB only for non-sensitive UI drafts if still needed,
   or remove it too.

## Phase E — Engineering standards sweep
1. ORM: every production table used has a Drizzle definition matching the Phase A snapshot 1:1 (types, nullability,
   defaults, charset). Convert raw `sql\``/`.query`/`.execute` to Drizzle query builder; warehouse/BigQuery SQL keeps
   bound parameters only. Start with top offenders (`offline-cash/legacy-import-schema.ts`, `order-history/search/native.ts`,
   `operational-reports/scheduled-data.ts`, `catalog-details/{audit,queries}.ts`, `returned-orders.ts`, `reports.ts`).
2. Query optimization: remove N+1/batch lookups only where golden + live output comparison proves identical
   (order, rounding, nulls, types). No index changes.
3. Validation: zod schema on every Fastify route (params/query/body/headers) — add a test enumerating registered
   routes and asserting each has schemas.
4. Tracing: keep `observability/context.ts` AsyncLocalStorage; rename/expose `traceId` (= requestId, honor inbound
   `X-Request-Id` if valid UUID), pass to repositories/services/queue jobs; frontend + Electron send `X-Request-Id`;
   pino mixin logs `traceId, module, resource, eventId, userId, eventInstanceId`; redact PII/secrets/SQL values.
5. Keep `no-explicit-any` at error; strict tsc clean in backend + frontend.

## Phase F — Verification (only after A–E complete)
1. Read-only live parity suite (`backend/tests/live-readonly/*.test.ts`, gated on `POS_PROD_RO_MYSQL_URL`):
   schema 1:1 vs `INFORMATION_SCHEMA`; every ORM read query (order search/detail, quote/discount/cashback inputs,
   inventory, operators, reports) runs with bounded `LIMIT`/indexed predicates and matches golden/legacy expectations.
2. Local loopback MySQL (`POS_VERIFY_MYSQL_URL`) seeded from snapshot DDL + small anonymized read-only subsets;
   run all mutating flows: checkout, refunds (duplicate-SKU), exchanges, recovery, offline sync, CSV tender pause,
   payment-failure restoration, voucher/cashback/points rules.
3. `npm run typecheck`, `lint`, `test`, `build` in backend + frontend; Playwright browser + Electron E2E for every
   route in `frontend/src/app.tsx` (zero console/network errors, no dead controls); `verify-project.ts --mysql
   --browser --release` with a new report file (never overwrite r9).
4. Offline billing E2E (Electron, loopback MySQL): disable network → bill cash + card-ref sales → kill/restart app
   (data persists) → confirm DB file is unreadable without the key (`sqlite3` open fails) → restore network → auto
   sync creates orders with `order_ref_no`, real invoice numbers appear → replay upload yields no duplicates →
   forced conflicts land in `needs_manager` and resolve via manager screen. Limits: 11th order and minute 121 are
   blocked (and with settings changed to e.g. 3 orders/5 min, the new values apply after next online contact);
   setting the clock back expires the window.
5. Confirm `find . -name '*.py' -o -name '*.go' -o -name '*.php'` (excl. node_modules) is empty; grep for `CREATE TABLE`/
   `ALTER TABLE` returns only test-fixture loading of the production snapshot.
6. Update `HANDOFF.md`, `CHECKPOINT.md`, `backend/parity/source-surface-map.*`, `release-coverage.json`,
   `docs/pull-requests/*` and PR #2 description with real commits and evidence; list external prerequisites
   (signing, Google client, BigQuery publications, provider sandbox creds). Release gate stays failing until all pass.

## Parallel workstreams (exclusive ownership)
- W1 Golden capture + test rewiring (`backend/tests/**`, `tools/verify-project.ts`).
- W2 Deletions (screening, compatibility, extras, Py/Go) — after W1 capture.
- W3 Auth/session/Redis re-home (`backend/src/auth/**`).
- W4 Checkout/returns/payment re-home + parity (`modules/checkout/**`, `frontend/src/pages/{checkout,returns}`).
- W5 Orders/admin/reports/BigQuery + ORM conversion (`modules/{order-history,administration,operational-reports}`).
- W6 Offline billing (`frontend/electron/**`, `frontend/src/offline/**`, new backend offline-sync route module).
Primary agent owns `app.ts`, `config.ts`, `db/legacy-schema.ts`, `package.json`, ledger.
