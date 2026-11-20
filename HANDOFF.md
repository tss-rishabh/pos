# POS rewrite handoff — 19 November 2026 (W22, final combined verification)

The single-stack, schema-frozen rewrite is integrated, and every product-code check passes on loopback. One test-tooling
typecheck in `verify-project` fails (open item 2).
**It is not production-ready:** the release gate fails by design until every surface and requirement has
evidence. This document replaces the 18 November handoff, which described the pre-freeze tree; that version
is in git history at `e392040f`.

## Start here

| Item | Value |
|---|---|
| Repository | https://github.com/tss-rishabh/pos (`origin`, work lands on `main`); upstream https://github.com/thesouledstore-tss/pos (PR #2) |
| Branch | `main`. The rewrite was developed on `refactor/single-stack-schema-freeze` |
| Checkout | `/Users/rishabhbhatia/code/pos-rewrite`, the only checkout (the other worktrees were removed on 20 November 2026). Local-only, gitignored: `backend/.env.uat` (UAT settings) and `.tmp/w26` (UAT run logs) |
| Integration merge | `b481fa91` (W21), on top of W19 `ecc966a9`, W20 `feb995c7`/`719a66a6` and W18 `a2382b4e` |
| Verified head | `b481fa91`. The W22 commits after it change only the source-surface map hashes, evidence and documentation |
| Legacy source | `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. `/Users/rishabhbhatia/code/backend-pos-web` is checked out at a different commit, but contains the pin; tools that need a checkout at the pin use a clone |
| Node | `/Users/rishabhbhatia/.npm/_npx/c9870267d9e0f935/node_modules/node/bin` (v24) |

**Read in this order:**
1. `AGENTS.md`: the mandate and every user decision.
2. `backend/parity/w22-verification.md`: the current verification matrix and its one failure. W18's
   `w18-verification.md` is the previous matrix; `w19`–`w21-report.md` describe the blocker fixes.
3. `backend/parity/security-decisions.md`: S1–S58.
4. `docs/pull-requests/pr-2-description.md`: the PR #2 text, a draft not yet pasted to GitHub.
5. `docs/plans/single-stack-schema-freeze.md`: the plan and its phase status.
6. The workstream reports, `backend/parity/w2-followups.md` and `w3`–`w21-report.md`.

## What the tree is now

- **Storage.** Production tables only: 119-table snapshot `backend/tests/golden/schema/production-schema.json`,
  Drizzle 0 mismatches. Ephemeral state goes in Redis under legacy key names where legacy has them, otherwise
  `pos:` keys. The ledger is `backend/parity/table-disposition.md`.
- **Jobs.** One Redis job queue and worker (`backend/src/jobs`, `npm run worker:jobs`) for the legacy Celery tasks
  and threads, plus gift-card batch generation.
- **Order submission.** API-v2 `pos/order`, exactly as legacy calls it.
- **Sign-in.** Password plus OTP/TOTP only; SSO is deleted.
- **Desktop offline billing.** Encrypted SQLite in the Electron main process. Limits come from
  `OFFLINE_BILLING_MAX_MINUTES` / `OFFLINE_BILLING_MAX_ORDERS`. The provisional reference is stored as a
  `comments` row.
- **Removed.** Screening, compatibility patches, cash-return intents, demo mode, CSV order import, SSO,
  groups/permissions admin, all `pos_rewrite_*` tables and migrations, and all Python/Go/PHP.

## Verification state (W22, on `b481fa91`)

Every check below ran on loopback: a private MySQL 8.4.11 with `sql_mode=''` and private Redis servers, all since
stopped. Nothing connected to production. W22 was the only agent running.

| Check | Result |
|---|---|
| Static (`tsc` ×3, `eslint` ×2) | All clean |
| Backend vitest, all MySQL gates, 2 runs | Both: 1189 passed, 0 failed, 17 skipped (live suite gated) |
| ORM metadata / route validation / log redaction | 0 mismatches / 336 of 336 routes / pass |
| Frontend vitest with all 7 browser gates, 3 runs | All three: 409 of 409 |
| Playwright web e2e, 2 runs on one stack | 41 of 41 both times; 0 unexpected console errors or failed requests (shared fixture) |
| Electron shell specs / offline billing, 2 runs | 2 of 2 / 12 of 12 both times |
| Builds | Backend, frontend and the unsigned macOS package all build |
| Container images and smoke | Both images build; smoke 10 of 10 (`backend/evidence/container-smoke-b481fa91-w22.json`) |
| `verify-project.ts --mysql --browser --release` | 84 of 85 executed checks passed. `order-payments-browser-fixture-typecheck` failed (open item 2), so `browser-tests` was not run. The gate failed. Evidence: `backend/evidence/verification-b481fa91-w22.json` |
| Integrity and credential greps | Clean |
| Live read-only production (primary agent, run 4) | 16 of 16 paths; schema 99 of 99 exact |
| Release gate | Fails: 396 surfaces and 12 requirements pending |

W22 made one mechanical fix: `4981db00` regenerated the stale source-surface map hashes. Release blockers 1–3 from
W18 are resolved:
- **Stale verifier harnesses:** W19.
- **E2E console errors and failed requests:** W20.
- **Flaky tests:** W21 and W20.

The evidence for each is in `w22-verification.md` §5.

## Open items

1. **Release requirements.** All 12 are pending in `backend/parity/release-coverage.json`
   (`warehouse-parity-and-freshness` is blocked).
2. **Verifier fixture typecheck (new in W22).** `order-payments-browser-fixture-typecheck` fails with six TS2769
   errors. Since `6e2dcdfe`, `e2e/checkout/order-payments.spec.ts` imports `backend/tools/e2e/fixture-orders.ts` and,
   through it, `seed.ts`, and their inserts omit NOT NULL columns. Until it is fixed, `verify-project` stops before
   `browser-tests`.
   - Root cause and fix options: `w22-verification.md` §2.
   - Owner: e2e tooling.
3. **Stale `remaining_code` entries.** Several entries in `backend/tools/parity/source-surface-families.json`
   describe work that later workstreams completed (`w18-verification.md` §6). They need an owner review.
4. **Missing legacy evidence.** The administration forms workflow (24 cases) and the browser halves of the native
   workflows (`w15-report.md`).
5. **No live or sandbox evidence** for writes, BigQuery reports, providers, `pos_stock_syncer*` or `worker:jobs`.
6. **Desktop disconnect cause unconfirmed.** W18's one desktop run lost its DevTools connection, and the cause is
   still unknown. W21 bounded the teardown, and the failure did not recur in 12 later complete runs (W21: 10; W22: 2).
7. **Stale doc references.** `parity/order-history.md`, `order-search.md` and
   `order-browser-default-fixture-repair.md` still name the deleted `browser-check.mjs` harnesses.

## External prerequisites

- API-v2 app credentials `API_V2_APP_ID`/`API_V2_APP_KEY`.
- Provider sandbox credentials.
- Apple signing and notarisation (plus a Windows Authenticode certificate and an app icon).
- Production Redis with `noeviction`, over TLS, on database 0.
- Staff must sign in again at cut-over.
- Payment mode 1001 active (it already is).
- `OFFLINE_BILLING_*` env.
- Rotate the read-only MySQL password.

## Re-running

The exact commands, ports and environment for each check are in `backend/parity/w18-verification.md` §7 and
`w22-verification.md` §7 (same-stack web runs, desktop port base).
- **Live read-only suite.** Primary agent only, with `POS_PROD_RO_MYSQL_URL` from the environment; see
  `backend/parity/live-readonly.md`.
- **Evidence files.** Never overwrite one. `verification-caba871-r9.json`, `verification.json` and
  `container-smoke.json` are historical; new runs go in new files.

## Standing rules

- Never connect to production, except the primary agent's live read-only suite.
- Never write to live services.
- Never add schema.
- Keep the release gate failing until the evidence exists.
- Do not claim production readiness.
