# Audit remediation handoff — 20 November 2026

Source: code review / security / parity audit of `~/code/pos-rewrite` at `d55cb12a` (branch
`audit/electron-security-logging`, no commits beyond `main`). The audit changed no files. `tsc --noEmit` passes on
backend, frontend and electron. The legacy reference is `~/code/backend-pos-web` (pin `78d5b63d`).

## Rules that bind this work (read AGENTS.md first; it wins over this file)

- Implementation before validation (standing order). Fix the code first, then run the full validation phase.
- Every change ships to and is verified on **web, desktop macOS and desktop Windows**, with evidence for each.
- Schema freeze: no new tables, columns, indexes or triggers. Ephemeral state goes in Redis.
- Logs: no PII, bodies, query values, credentials or raw SQL errors. **Do not** adopt `user.email`,
  `context.params` or `context.payload` from the reviewer's requested log schema.
- Security choices go in `backend/parity/security-decisions.md` as the next S-number. Parity divergences go in the
  module's parity note, with the legacy behaviour alongside.
- No writes against live services. Only `github.com/tss-rishabh/pos`; push to `main` only after the Windows and
  macOS legs of `desktop-platforms.yml` pass.
- Parallel agents: one workstream per agent, using the file ownership below. Shared config goes through the
  primary agent.

## Workstream A — refund amount parity (HIGH, do first)

Owner: `backend/src/modules/checkout/return-workflow/**`, `backend/tests/golden/checkout/**`

- Bug: `return-workflow/gateway.ts:432` rejects `amount.decimalPlaces() > 2`. API-v2's cash branch returns an
  unrounded float (`backend-tss-api_v2/controllers/OrderController.py:11360-11398`), for example `0.010000000000005116`
  on orders that part-paid with TSS money or a gift voucher. The customer is refunded, then the POS returns 502:
  stock is not returned, there is no transaction log and day close is not marked stale. A retry gets
  "Already refunded".
- Fix: accept any finite non-negative number. Set `returnAmount = pythonRound2(raw).toFixed(2)` and keep
  `returnAmountRaw`. Legacy behaviour is in `order/views.py:947-966`.
- Add a golden case with float noise, and a test that `complete()` runs.

## Workstream B — offline sync must never auto-resend an uncertain sale (HIGH)

Owner: `frontend/electron/offline/{server,service,database}.ts`, `backend/src/modules/offline-sync/**`

- Client: `server.ts:203-204` (timeout/abort) and `:224-230` (5xx/408/429) return `retry`, and so does
  `INVALID_SERVER_REPLY` at `:208`. `database.ts:724-727` `recoverInterrupted` puts `syncing` sales back in the
  queue.
  - Automatic retry is allowed only for a connection failure before the request was sent, or for an explicit
    pre-dispatch code (`OFFLINE_SYNC_IN_PROGRESS`, `CHECK_IN_REQUIRED`, `OPERATOR_CHANGED`).
  - Everything else → `markConflict('OUTCOME_UNKNOWN')`.
  - On restart, recover `syncing` as `needs_manager`.
  - After N retries, escalate to `needs_manager` (today, a permanent 503 or `INVALID_SERVER_REPLY` retries forever).
- Server: in `offline-sync/service.ts` around `:615-640`, the no-Redis-record path falls back to `findByComment`,
  but the `comments` row is written only after success. Before `create()`, run a candidate match (same counter and
  lines, created at or after billedAt − 1 day) and return `OUTCOME_UNKNOWN` if one matches. Document that Redis
  needs AOF and `noeviction` (or `volatile-*`) in `deployment.md`.
- Also in this workstream:
  - **Server limits:** `/offline-sales` (`service.ts:560-603`) accepts any authenticated session with no cap.
    Add a per-device Redis counter per offline episode against `OFFLINE_BILLING_MAX_ORDERS`, and reject
    `billedAt` in the future. Record this as an S-decision.
  - **Time limit bypass:** `frontend/src/offline/billing/limits.ts:59-64` stops counting during system sleep.
    Use `max(monotonic, wall delta)` while running, and advance on `powerMonitor` `resume`.
  - **Resolved sales uploaded by the wrong user:** `service.ts:335-339` uploads a manager-resolved sale while a
    cashier is signed in. That yields 403 `MANAGER_REQUIRED`, which overwrites `OUTCOME_UNKNOWN`. Skip the sale
    unless `operator.id === resolution.managerId`.
  - **Offline before the first probe:** `createSale` (`service.ts:438`) can bill offline before the first probe
    finishes. Require `probed`.
  - **Missing key file:** `key-store.ts` creates a new key when the key file is missing but
    `offline-billing.db` exists. Refuse instead.
  - **Leaking error text:** `runtime.ts:189-194` sends a raw `error.message` to the UI. Use fixed messages for
    the known error classes and log only a code.

## Workstream C — web security headers (HIGH)

Owner: `frontend/nginx/**`

- `default.conf.template`: the `add_header` lines in `location = /index.html`, `/assets/` and `/service-worker.js`
  cancel the server-level `X-Frame-Options`, `nosniff` and `Referrer-Policy`. Every SPA route serves
  `/index.html`, so the web client can be framed.
- Fix: add `add_header_inherit merge;` at server level (the pinned nginx 1.30.6 supports it), or repeat the
  headers in each location. Also send a CSP header with `frame-ancestors 'none'` (a meta CSP cannot set it).
- Add a test that fetches `/`, `/some/spa/route`, `/index.html` and an asset and checks the headers.

## Workstream D — logging and error reporting (HIGH/MEDIUM)

Owner: `frontend/electron/offline/runtime.ts` (the log function only, coordinate with B), `frontend/electron/main.cjs`
(logging lines only), `frontend/src/components/error-boundary.tsx`, `backend/src/observability/**`, new event-registry
files

- **Desktop log sink:** `runtime.ts:24-37` writes to stdout, which installed builds discard. Write rotating, size-capped
  JSONL to `app.getPath('logs')`, and keep stdout in development only. Fix the record shape to match the backend:
  add `level` and `msg`; use epoch-ms `time`; use `errorCode`, not `code`; spread `...event` first so it cannot
  overwrite `module` or `requestId`; set `userId` from the operator.
- **Schema:** add `process` (`server|worker|main|preload|renderer`). `details` is a fixed message with no values.
- **UI error reporting:** add `componentDidCatch`, `window.onerror` and `unhandledrejection` handlers that send
  ID-only events (`errorName`, route; never the message or props). Desktop sends them over a new allowlisted IPC
  channel; web sends them to a beacon endpoint registered in the event catalog. Add a `render-process-gone`
  handler in main.
- **Failures that log nothing:**
  - `main.cjs:178-183` swallows offline-billing start-up failures.
  - `offline/service.ts:351-385` (conflict and retry) and `:588` log nothing.
  - `offline/service.ts:244-256` has silent catches.
  - `offline-sync/service.ts:447-467` drops the original error code on `unknownOutcome`.
  - `checkout/payments/service.ts:296` has a bare `catch`.
  - `ipc.ts:78-88` should log `errorName`.
- **Event registry:** one `as const` registry per process, with the logger typed to it. About 75 free-form `eventId`
  values exist today, including templates such as `cancellations/repository.ts:89` and `payments/routes.ts:49`.
- **Request IDs:** derive one request ID per upload or HTTP call from the shared sync trace ID
  (`offline/service.ts:238-282, 351`). Carry `requestId` into `OfflineBillingClientError` (`bridge.ts:52`). Forward
  `X-Request-Id` on the internal invoice call (`checkout/invoices.ts:222`).

## Workstream E — backend authorization, routing and performance (MEDIUM)

Owner: `backend/src/modules/{legacy-order-status,administration,operational-reports,finance}/**`,
`backend/src/modules/checkout/{finalizer.ts,cancellations/**}`, `backend/src/db/migrations.ts`

- **Writer-pool auth:** `legacy-order-status/service.ts:72-97,135-139` authorizes an external push on the reader
  pool. Use `assertCurrentStoreAccess` in a writer transaction.
- **Import progress cost:** `administration/import-job.ts:582-588` copies and rewrites growing progress arrays to
  Redis for every row. Checkpoint every N rows, or use `RPUSH` plus a counter.
- **Row-by-row inserts:** `administration/service.ts:654, 1421, 1630-1633` insert one row per loop iteration. Use
  one multi-row `insert().values([...])` (legacy uses `bulk_create`, `users/views.py:589`).
- **Unescaped LIKE:** `checkout/finalizer.ts:146-147` and `return-workflow/repository.ts:1426, 1877` build LIKE
  prefixes from the store code without escaping. Escape `\ % _` (coordinate the last two with A). At
  `finalizer.ts:138`, a NULL store code must format as `'None'`, as legacy does.
- **Small inefficiencies:** `operational-reports/scheduled-data.ts:559` does `filter`+`some` (use a Set), and
  `drafts.ts:144` does one GET per draft (use MGET).
- Delete the dead `src/db/migrations.ts` and fix the stale line reference in `parity/orm-exceptions.md`.

## Workstream F — desktop main-process performance and Electron hygiene (MEDIUM)

Owner: `frontend/electron/offline/database.ts` (performance parts, coordinate with B), `frontend/electron/*.cjs`,
`frontend/electron/tsconfig.json`, `frontend/eslint.config.mjs`, renderer status consumers

- **Status writes:** `status()` → `tick()` → `setWindow` writes with `synchronous=FULL` on every read
  (`service.ts:75-85`), and three components poll it. Make `status()` read-only (persist only in the 60 s tick),
  debounce `changed()`, and share one status store across `connection-status.tsx`, `auto-switch.ts` and
  `offline-billing/index.tsx`.
- **Catalog refresh:** `replaceCatalog` (`database.ts:452-489`) runs one big synchronous transaction. Chunk it,
  yielding between chunks, or move SQLite into a `utilityProcess`.
- **Catalog cap:** the catalog silently stops at 30,000 products (`service.ts:55`). Log or flag the truncation and
  raise the page size.
- **Statements and sale lists:** prepare statements once. Batch-load sale lines (`toSale`, `database.ts:315-352`).
  Prune old synced sales, including their card/UPI references.
- **Type-check and lint the shell:** add `checkJs` or `// @ts-check` with Electron types for `main.cjs`,
  `preload.cjs`, `workspace-config.cjs` and `runtime-mode.cjs`, and lint `electron/**`. Add a test that the
  preload channel set equals `ipcChannels`.
- **IPC channels:** remove the duplicate `offline:sync:status`, rename the push event out of the invoke namespace,
  and remove the unused `setReachable`.
- **UI:** give the resolve dialog a busy state and in-modal errors, add a route-level error boundary on
  `/offline-billing`, and hide the "Offline billing" nav link on web.

## Workstream G — maintainability (LOW, after A–F)

- Consolidate the Python-compat helpers into `backend/src/domain/python-compat.ts`. Today there are three repr
  copies, two `pythonInt`, and two JSON dumps (`payments/gateway.ts:43`, `import-domain.ts:145`), and the two float
  formatters already disagree. Test the module against the goldens.
- Split the god modules: `checkout/service.ts` (2401 lines), `return-workflow/repository.ts` (2095),
  `administration/service.ts` (1647), `CheckoutReview.tsx` (1641).
- Fix the typo "from0.01 to99999." in `checkout/benefit-adjustments/fields.ts:76` and
  `frontend/src/offline/benefits/fields.ts:77`.
- Use `pythonRound2(rate).toFixed(2)` for the Slack acceptance rate in `operational-reports/scheduled-domain.ts:220,225`.

## Decisions needed from the user (ask; do not decide)

1. Customer history at checkout reads BigQuery only (`customer-history/index.ts:30-60`). Legacy reads MySQL live,
   and the 19 November order decision says MySQL. Same-day orders are missing today.
2. The Glassbox finance feed moved from `/reports/api/v1/reconciliation/<feed_type>/` with a
   `{success,error}` body to `/api/v1/finance/reconciliation/orders` with the global error body. It also reads
   today's returns from BigQuery, where legacy used MySQL. This is an external consumer: alias the old path or
   approve the change.
3. The PG-discount approver tier uses exact decimals; legacy truncated with `parseInt`. Near 10% this picks a
   different approver.
4. A gift card's start date defaults to today; legacy sent "".
5. Unrecorded tightenings: no negative wallet repair, 422 on an unknown return reason, a 255-character return
   comment cap.

## Validation phase (only after A–G code is in)

- Add backend `npm test` (vitest) to `desktop-platforms.yml`. Today only the backend typecheck runs, so no golden
  test runs in CI. Run it on both the macOS and Windows legs.
- Add golden fixtures for auth flows, offline sync, `catalog.ts` and `reports.ts`. Fix the 11 self-referential golden
  tests and the 4 orphaned goldens (`INVENTORY.md`).
- Run the full source parity, native, browser, offline, security, performance and deployment validation, and report
  web, macOS and Windows separately.
- Leave the release gate failing until every surface has evidence.

## Decisions (user, 20 November 2026)

These answer the five questions above. AGENTS.md carries the same list.

1. **Customer history reads MySQL**, as legacy, for all dates, so same-day orders appear. Record this in the
   module's parity note.
2. **Glassbox feed: the new path is approved.** It is `/api/v1/finance/reconciliation/orders` with the global error
   body, and it reads today's returns from BigQuery. Record it as an approved divergence in the finance parity note,
   with the legacy path, body and MySQL source alongside. Glassbox must be updated before cut-over.
3. **PG-discount approver tier matches legacy `parseInt` truncation.** Add a golden case at the 10% boundary.
4. **Gift-card start date keeps the default of today.** Record it as an approved divergence (legacy sent `""`).
5. **The three tightenings stay**: no negative wallet repair, 422 on an unknown return reason, and a 255-character
   return comment cap. Record them as S61, S62 and S63 in `backend/parity/security-decisions.md`, with the legacy
   behaviour in the module parity notes.

Decisions 1 and 3 change code; 2, 4 and 5 change documentation. Together they make **workstream H**. Owner:
`backend/src/modules/customer-history/**`, `backend/src/modules/checkout/discounts/**`, and the finance and
gift-card parity notes. The primary agent allocates S-numbers. B's offline-limit decision takes S64.

## Execution order

1. A runs alone and first.
2. B, C, D, E, F and H then run in parallel worktrees.
   - B merges before D and F, which touch the same offline files.
   - E's LIKE escaping in `return-workflow/repository.ts` lands after A.
3. G runs last.

Only the primary agent edits shared configuration: `desktop-platforms.yml`, `eslint.config.mjs`, `deployment.md`,
`security-decisions.md` and AGENTS.md.
