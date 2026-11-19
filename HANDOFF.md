# POS rewrite handoff — 19 November 2026 (W18, Phase F)

The single-stack, schema-frozen rewrite is integrated and has passed local verification on loopback.
**It is not production-ready:** the release gate fails by design until every surface and requirement has
evidence. This document replaces the 18 November handoff, which described the pre-freeze tree; that version
is in git history at `e392040f`.

## Start here

| Item | Value |
|---|---|
| Repository | https://github.com/thesouledstore-tss/pos (PR #2) |
| Branch | `refactor/single-stack-schema-freeze` |
| Worktree | `/Users/rishabhbhatia/code/pos-rewrite-single-stack` |
| Integration merge | `8a7530aa` (W14) |
| Verified head | `a2382b4e`: W18 mechanical test and tooling fixes on top of `8a7530aa`. Product code (`backend/src`, `frontend/src`, `frontend/electron`) is unchanged since `8a7530aa`; later commits change only documentation and evidence |
| Legacy source | `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. `/Users/rishabhbhatia/code/backend-pos-web` is checked out at a different commit, but contains the pin; tools that need a checkout at the pin use a clone |
| Node | `/Users/rishabhbhatia/.npm/_npx/c9870267d9e0f935/node_modules/node/bin` (v24) |

**Read in this order:**
1. `AGENTS.md`: the mandate and every user decision.
2. `backend/parity/w18-verification.md`: the current verification matrix and failures.
3. `backend/parity/security-decisions.md`: S1–S57.
4. `docs/pull-requests/pr-2-description.md`: the PR #2 text, a draft not yet pasted to GitHub.
5. `docs/plans/single-stack-schema-freeze.md`: the plan and its phase status.
6. The workstream reports, `backend/parity/w2-followups.md` and `w3`–`w17-report.md`.

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

## Verification state (W18)

Every check below ran on loopback: a private MySQL 8.4.11 with `sql_mode=''` and private Redis servers, all since
stopped. Nothing connected to production.

| Check | Result |
|---|---|
| Static (`tsc` ×3, `eslint` ×2) | All clean |
| Backend vitest, all MySQL gates | 1187 passed, 0 failed, 17 skipped (live suite gated) |
| ORM metadata / route validation / log redaction | 0 mismatches / 335 of 335 routes / 4 of 4 |
| Frontend vitest with browser gates | 408 of 409 passed (1 flaky) |
| Playwright web e2e | 41 of 41 passed |
| Electron offline billing | 12 of 12 passed on the rerun (the first run had 1 failure and 1 not run) |
| Builds | Backend, frontend and the unsigned macOS package all build |
| Container images and smoke | Both images build; smoke 10 of 10 |
| `verify-project.ts --mysql --browser --release` | Run 2: 81 of 85 checks passed, 3 stale browser harnesses failed, and the gate failed. Evidence: `backend/evidence/verification-a2382b4e-single-stack.json` |
| Integrity and credential greps | Clean |
| Live read-only production (primary agent, run 4) | 16 of 16 paths; schema 99 of 99 exact |
| Release gate | Fails: 396 surfaces and 12 requirements pending |

W18 made only mechanical fixes, each in its own commit:

| Commit | Fix |
|---|---|
| `7466be6f` | A stale `rewriteMigrations` reference |
| `7d2976d8` | Tuple typing in a test |
| `a3618584` | Tuple typing in a test |
| `c243cf37` | Tuple typing in a test |
| `5d0bf44f` | Removed verifier checks for deleted files |
| `f600dd54` | Forwarded `E2E_MYSQL_URL` to the verifier's Playwright check |
| `a2382b4e` | Removed the deleted local-delivery browser fixtures from the verifier |

## Open items

1. **Release requirements.** All 12 are pending in `backend/parity/release-coverage.json`, and `legacy-authentication` (which replaced the deleted `sso-integration`) is
   obsolete. Decide whether to remove that id from `backend/src/domain/release.ts`.
2. **E2E console errors and failed requests.** These need owners; the list is in `w18-verification.md` §3.
   - pre-login 401 probes
   - 403 notifications for a store the operator is not checked into
   - invoice sandbox "Blocked script execution"
   - unmocked wallet-spec requests
   - logout `GET /stores` 401
3. **Flaky tests.**
   - The admin profile-image browser test: `private-images.tsx` sets "Image saved." while the busy status is still
     rendered.
   - The desktop O10 "page closed" failure: not reproduced, cause unconfirmed.
4. **Stale `remaining_code` entries.** Several entries in `backend/tools/parity/source-surface-families.json` describe
   work completed later (`w18-verification.md` §6). They need an owner review.
5. **Missing legacy evidence.** The administration forms workflow (24 cases) and the browser halves of the native
   workflows (`w15-report.md`).
6. **No live or sandbox evidence** for writes, BigQuery reports, providers, `pos_stock_syncer*` or `worker:jobs`.
7. **Stale browser harnesses.** Three standalone mocked-API harnesses, `frontend/tests/{order-search,order-history,reports}/browser-check.mjs`, predate the W5, W8 and W12 contract changes and fail in `verify-project` (`w18-verification.md` §4). They need re-authoring. Until then the verifier stops before its Playwright stage.
8. **Undocumented environment.** `OFFLINE_BILLING_*` is not in `backend/.env.example`.

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

The exact commands, ports and environment for each check are in `backend/parity/w18-verification.md` §7.
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
