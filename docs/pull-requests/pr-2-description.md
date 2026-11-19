# PR #2 — POS rewrite: single stack, frozen production schema, legacy parity (draft description)

> Draft for https://github.com/thesouledstore-tss/pos/pull/2. The GitHub PR has **not** been edited; the
> primary agent or the user pastes this text there. Branch `refactor/single-stack-schema-freeze`. The
> verified head is `b481fa91` (W19–W21 merged on top of W18). W22's later commits change only the
> source-surface map hashes, evidence and docs.

## Mandate and decisions

The rewrite ports the legacy Django POS (`backend-pos-web@78d5b63`) to Node 24 / TypeScript / React / Electron,
with strict 1:1 business behaviour and no production schema change. The user's decisions of 18–19 November 2026
are recorded in [`AGENTS.md`](../../AGENTS.md) and bind every agent:

- **Production schema freeze.** No new tables, columns, indexes or triggers. Durable data goes only into existing
  production tables, written synchronously as legacy does. Ephemeral state goes in Redis.
- **Node/TS/React/Electron only.** No `.py`, `.go` or `.php`. Legacy oracles are replaced by committed golden JSON
  plus a guarded read-only live MySQL suite.
- **Removed:** screening, `backend/compatibility/**`, cash-return intents, demo mode, CSV import authority
  succession, then all CSV order import, Google SSO and desktop SSO.
- **One approved addition:** desktop offline billing.
- Module decisions (checkout, orders, administration, jobs, ORM, offline card/UPI) are listed in `AGENTS.md` by date.
- The execution plan and its status are in [`docs/plans/single-stack-schema-freeze.md`](../plans/single-stack-schema-freeze.md).

## Architecture now

- **Backend** (`backend/`): Fastify on Node 24, Drizzle over MySQL with primary / data-reader / writer routing,
  BigQuery for reports only. Every one of the 336 routes validates params, query, body and headers with zod.
  Authentication runs before validation (S50). Structured logs carry trace, request, user and resource event IDs,
  with PII, bodies, cookies, OTPs and SQL stripped.
- **Production tables plus Redis.** Drizzle defines only production tables; `tests/orm-metadata.test.ts` compares
  them with the 119-table production snapshot (0 mismatches). The 226 `pos_rewrite_*` tables are gone: 136
  deleted with their features, 30 replaced by the production table legacy uses, and 60 replaced by Redis key
  families (sessions, hashed OTP, check-ins under legacy key names, idempotency, locks, recovery claims). See
  `backend/parity/table-disposition.md`.
- **Job queue.** One Redis queue and worker (`backend/src/jobs`, `npm run worker:jobs`) for the legacy Celery
  tasks and threads: CSV stock/product-store imports, order SMS through API-v2 `omnichannel-sms`, ecommerce
  inventory sync, whole-order status push, hyperlocal auto-reject and transfer, advance-order notifications, the
  six report exports, and gift-card batch generation. Scheduled Slack reports run inline, and hyperlocal expiry
  runs when the progress page opens, both as legacy does. Design: `backend/parity/phase-c-legacy-jobs.md`.
- **Order submission** calls API-v2 `pos/order` exactly as legacy does. The order is created only after the
  operator confirms the payment form. A transport failure stays "uncertain" and is never retried automatically (S26).
- **Frontend** (`frontend/`): React for web and the Electron desktop shell (sandboxed, isolated renderer, fuses,
  navigation allowlists).
- **Offline billing (desktop only).** Encrypted SQLite (SQLCipher) in the Electron main process, with the key
  wrapped by `safeStorage`. Payment is cash, or a manually entered card/UPI reference that settles as legacy
  "Others" (1001). The receipt shows a provisional reference, and the real invoice number arrives at sync. No
  benefits. The order is created through the normal path and the provisional reference is stored as a legacy-style
  `comments` row; `orders.order_ref_no` is never written. Sync is automatic on reconnect, idempotent in Redis,
  and an uncertain outcome goes to a manager and is never resent. Limits: `OFFLINE_BILLING_MAX_MINUTES` (default
  120) and `OFFLINE_BILLING_MAX_ORDERS` (default 10), whichever comes first. A wall clock moved backwards blocks
  billing. Web clients need internet.

## What was removed

- 226 `pos_rewrite_*` tables, 102 registered migrations, `src/db/migrations.ts` and its scripts, 49 `*.review.sql`
  files, and all module `migration.sql` files.
- Every `.py`, `.go` and `.php` file, together with their requirements, Go fixtures and the Python
  customer-contacts service. The parity tooling was ported to TypeScript.
- Features: screening (SKU 390238 writer and workers), `backend/compatibility/**` upstream patches, the cash-return
  intent protocol, demo mode, CSV order import and its authority succession and tender pause, Google and desktop
  SSO, the groups/permissions admin, the product-store CSV upload page, the admin "export all", four rewrite-only
  exports, the old IndexedDB offline cash, and the extra day-close window check.

## Verification matrix (loopback only; `b481fa91`)

Full detail and root causes: [`backend/parity/w22-verification.md`](../../backend/parity/w22-verification.md).
The earlier matrix (W18, `a2382b4e`) is in `w18-verification.md`.

| Check | Result |
|---|---|
| `tsc --noEmit` backend / frontend / Electron | 0 errors / 0 / 0 |
| `eslint .` backend / frontend | 0 problems / 0 |
| Backend vitest, every MySQL gate on (MySQL 8.4.11, `sql_mode=''`, private Redis), **2 runs** | Both runs: 221 files, 220 passed and 1 skipped. 1206 tests: **1189 passed, 0 failed**, 17 skipped (the live production suite, gated) |
| `orm-metadata` / `route-validation` / `log-redaction` | 0 mismatches over 119 snapshot tables / 336/336 routes / pass |
| Frontend vitest, all 7 browser gates on, **3 runs** | All three: 74/74 files, **409/409 tests** |
| Playwright web e2e on the real stack, **2 runs on one stack** | **41/41 both times** (including the 2 Electron shell specs). The shared fixture found **0 unexpected console errors, 0 unexpected failed requests and 0 page errors**. Each run declared the same deliberate failures: 23 negative cases and 1 timing-bound cancellation |
| Electron offline billing, 12 scenarios, **2 runs** | **12/12 both times**, with no lost window and no SIGTERM fallback |
| Builds | Backend `tsc` build, frontend web and Electron bundles, unsigned macOS arm64 package: all pass |
| Container images and smoke | Both images build; smoke **10/10** (`backend/evidence/container-smoke-b481fa91-w22.json`) |
| `tools/verify-project.ts --mysql --browser --release` | Exit 1. 85 of 86 checks ran and **84 passed**, including the three W19 real-stack harnesses. **Failed:** `order-payments-browser-fixture-typecheck`, a test-tooling typing regression from `6e2dcdfe` (see Known gaps). `browser-tests` is therefore not run, and the release gate fails. Evidence: `backend/evidence/verification-b481fa91-w22.json` |
| Integrity greps | No `.py/.go/.php`; no DDL outside the allowed places; `pos_rewrite_` in `backend/src` only in comments; no `DEMO_MODE` in code; no `any`; no credentials (the PEM marker appears only in the public RDS CA bundle and in report prose) |
| Release gate (`tools/parity-gate.ts`) | **Fails, as required**: 396 surfaces and 12 requirements pending |

**Live read-only production suite** (run by the primary agent; read-only, SELECT-only account):
`backend/evidence/live-readonly-2026-11-19-r4.json`, MySQL 8.0.39.
- **16/16 paths pass:** 365 statements, 193 EXPLAINs, 0 locking reads, 0 refusals, 0 plan rejections, and 3
  LIMIT-bounded plans.
- **Schema:** 99/99 Drizzle-mapped tables match production in `exact` DDL mode.
- **Scope:** read paths only. This is not value-level parity with legacy (`backend/parity/live-readonly.md`).

## Approved divergences

Where legacy behaviour was a security hole, the rewrite takes the secure option. Decisions S1–S58 are in
[`backend/parity/security-decisions.md`](../../backend/parity/security-decisions.md), pending the user's review.
Examples: S1 password always checked; S3 hashed login OTP; S4 proper HTTP statuses; S24 cross-store lookup
audited; S35 server-side exchange guards; S45 franchise store scope; S54 log redaction.

The approved business divergences are recorded in `AGENTS.md`:
- the two hyperlocal fixes (split orders move to status 21; the transfer reason goes to the right field);
- CSV `IsHold=0` unholds;
- explicit `''` for out-of-enum values under the empty `sql_mode`;
- franchise store visibility (S45);
- the working gift-card id search.

## External prerequisites

- API-v2 app credentials, `API_V2_APP_ID` / `API_V2_APP_KEY`. Without them, the customer `check-user-exclusive`
  lookup answers 503.
- Provider sandbox credentials for an end-to-end provider check: API-v2 `pos/order` and the payment microservice,
  Paytm/Pine terminals, Gupshup, Netcore, mailr, Borzo and Slack. No provider has been called.
- Apple signing and notarisation: a Developer ID certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`), notarisation
  credentials, an entitlements plist and an app icon. Windows needs an Authenticode certificate. Keep one Team ID
  and `appId`, so that `safeStorage` keys stay readable (`backend/parity/w17-report.md` §4).
- Redis in production with `maxmemory-policy noeviction`, over TLS, on database 0.
- Staff must sign in again at cut-over. Legacy `django_session` sessions and plaintext `login_otp:*` codes are not
  honoured.
- Payment mode 1001 ("Others") must be active in `pos_terminal_payment_modes`. It already is.
- The offline billing environment, `OFFLINE_BILLING_MAX_MINUTES` / `OFFLINE_BILLING_MAX_ORDERS`. The defaults are
  120 and 10, as listed in `backend/.env.example`.
- Rotate the read-only MySQL password. It was shared in chat for the live suite.

## Known gaps

- **Release certification.** No source surface or release requirement is certified (396 surfaces and 12
  requirements pending). The local suites prove the rewrite against goldens and loopback fixtures. They do not
  prove business-value parity with legacy on production data.
- **Live paths.** Writes, BigQuery reports, Redis state and every provider have no live or sandbox evidence. The
  stock procedures `pos_stock_syncer*` and `worker:jobs` have never run against real services.
- **Legacy evidence.** The administration forms workflow (24 cases) and the browser halves of the native workflows
  have no legacy golden (`w15-report.md`).
- **Verifier fixture typecheck.** `order-payments-browser-fixture-typecheck` fails with six TS2769 errors.
  - **Cause.** Since `6e2dcdfe`, `e2e/checkout/order-payments.spec.ts` imports `backend/tools/e2e/fixture-orders.ts`
    and `seed.ts`. Their inserts omit NOT NULL columns, which MySQL defaults under `sql_mode=''`.
  - **Effect.** `verify-project` stops before its Playwright stage. The suite itself passes 41/41 twice on one stack.
  - **Fix.** It needs type-complete e2e inserts, not an exclusion (`w22-verification.md` §2).
- **Desktop disconnect cause.** One W18 desktop run lost its DevTools connection, and the cause is unconfirmed. W21
  bounded the teardown, and it has not recurred in 12 later complete runs.
- **Stale families.** Several remaining-code families in `tools/parity/source-surface-families.json` describe work
  that later workstreams completed (fast checkout, type-8 guard, whole-order status push, contacts, website
  handoff). They need an owner review before the map is used for planning.
- **Gate entry renamed.** `sso-integration` was replaced by `legacy-authentication` (password + OTP/TOTP), still pending.
- **Untested platforms.** Windows has no build, e2e or signing run, and no physical printer or device has been
  tested.

## Release gate

`backend/tools/parity-gate.ts` fails, and must keep failing until every feature and required background job has
implementation and test evidence. **Production readiness is not claimed.**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
