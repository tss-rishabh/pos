# W22: final combined verification of the integrated head

**Branch and heads.**
- Branch: `refactor/single-stack-schema-freeze`.
- Verified head: `b481fa91` (merge W21), which contains W19 (`ecc966a9`), W20 (`feb995c7`, follow-up `719a66a6`),
  S58 (`83391337`) and W21 (`b481fa91`) on top of W18's `a2382b4e`.
- W22 commits: `4981db00` (regenerated source-surface map hashes), `79b833a2` (new evidence files) and the
  documentation commits after them. None of them touches `backend/src`, `frontend/src`, `frontend/electron`,
  tests or tooling, so every result below describes the product code of `b481fa91`.

**Environment.** Everything ran on loopback. Nothing connected to production, and `POS_PROD_RO_MYSQL_URL` was unset.
- MySQL 8.4.11, `--no-defaults --sql-mode=''`, on 127.0.0.1:33922, with its data dir under the worktree `.tmp/w22`.
- Private `redis-server` instances, spawned by the tests and the e2e stacks.
- Node 24.22.3, Chrome 157.0.8103.80, Playwright 1.65.1, Electron 45.3.2.
- Docker Desktop 29.8.2, started for the image builds and the smoke test, then quit.
- W22 was the only agent running. Load averages were 2–26.
- Every service W22 started was stopped at the end, by PID.

## 1. Matrix

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Backend typecheck | `npx tsc --noEmit -p .` | 0 errors |
| 2 | Frontend typecheck | `npx tsc --noEmit -p .` | 0 errors |
| 3 | Electron typecheck | `npx tsc --noEmit -p electron/tsconfig.json` | 0 errors |
| 4 | Lint | `npx eslint .` (backend, frontend) | 0 problems, both |
| 5 | Backend vitest, every MySQL gate (the 26 URLs from `verify-project.ts`, `ORDER_DETAIL_BROWSER_TEST=true`, `ORDER_SEARCH_SOURCE_ROOT` = a clone at `78d5b63`), **run twice** | `npx vitest run --no-file-parallelism --maxWorkers=1` | **Run 1 and run 2 are identical.** 221 files: 220 passed, 1 skipped. 1206 tests: **1189 passed, 0 failed, 17 skipped** (`tests/live-readonly`, gated on the production URL). 132.6 s and 131.5 s |
| 6 | ORM metadata | `tests/orm-metadata.test.ts` (in row 5) | Pass, **0 mismatches** against the 119-table snapshot |
| 7 | Route validation | `tests/route-validation.test.ts` (in row 5) | Pass. "**336/336 routes fully covered**". The extra route compared with W18 is the public `GET /api/v1/auth/session-state` (W20, S58) |
| 8 | Log redaction | `tests/observability/log-redaction.test.ts` (in row 5) | Pass |
| 9 | Frontend vitest, all 7 browser gates, **run 3 times** | `ADMINISTRATION_… PRODUCT_FEEDBACK_BROWSER_TESTS=true npx vitest run` | **3/3 green.** Each run: 74/74 files, **409/409 tests**, 32–34 s |
| 10 | Playwright web e2e, **twice in a row on one stack** | One `tools/e2e/stack.ts` + `vite preview` on 4410/4173, started once; then `npx playwright test` twice through a temporary, uncommitted config with `reuseExistingServer: true` | **Run 1: 41/41. Run 2: 41/41** (1.4 min each). The shared fixture reports **0 unexpected console errors, 0 unexpected failed requests and 0 page errors** in both runs. Both runs declared the same deliberate failures: 20 failed responses, 3 failed requests, their 23 console lines, and 1 timing-bound `ERR_ABORTED` |
| 11 | Electron shell specs | `e2e/electron.spec.ts`, inside row 10 | 2/2 in each run |
| 12 | Electron offline billing, 12 scenarios, **run twice** | `E2E_DESKTOP_PORT_BASE=4610 DEBUG=pw:browser E2E_MYSQL_URL=…/pos_rewrite_e2e_offline npx playwright test -c playwright.desktop.config.ts` | **Run 1: 12/12. Run 2: 12/12** (6.1 min each). There were no "lost the window" or SIGTERM-fallback lines. The only DevTools disconnects are the 4 expected ones per run, when the app exits normally (two launches per run). No stack process was left behind |
| 13 | Backend production build | `npm run build` | Pass (`dist/server.js`, `dist/jobs/worker-main.js`) |
| 14 | Frontend production build | `npm run build` (typecheck, web bundle, `electron/dist/offline-billing.cjs`) | Pass |
| 15 | Electron package | `CSC_IDENTITY_AUTO_DISCOVERY=false POS_DESKTOP_URL=https://pos.example.test npx electron-builder --mac --dir --arm64` | Pass. `Souled POS.app`, 262 MB, ad-hoc signature, no Team ID. `offline-sqlite/prebuilds/darwin-arm64.node` is present |
| 16 | Container images | `docker build -t pos-rewrite-{backend,frontend}:w22 {backend,frontend}` | Both build: backend `dfb14d6de9c7` (579 MB), frontend `b42140f6b238` (92.3 MB) |
| 17 | Container smoke | `POS_{BACKEND,FRONTEND}_TEST_IMAGE=pos-rewrite-…:w22 node tools/smoke-containers.cjs`, run from a throwaway worktree | **10/10** checks. New evidence: `backend/evidence/container-smoke-b481fa91-w22.json`. The tool's fixed output landed in the throwaway tree |
| 18 | `tools/verify-project.ts --mysql --browser --release` | §3 | Exit 1, `productionReady: false`. 86 checks expected and 85 run: **84 passed, 1 failed** (`order-payments-browser-fixture-typecheck`, §2). `browser-tests` was not run, because the verifier stops after a failure. The release gate fails, as required. Evidence: `backend/evidence/verification-b481fa91-w22.json` |
| 19 | Source-surface map | `node --import tsx tools/parity/build-source-surface-map.ts --check` | **Stale on `b481fa91`**: only the recorded SHA-256 hashes of files edited by W19–W21 had changed. Regenerated in `4981db00`, after which `--check` passes. Still 396 surfaces, 0 unmapped, 9 remaining-code groups, 0 certifications |
| 20 | Release gate | `LEGACY_SOURCE_ROOT=<clone at 78d5b63> node --import tsx tools/parity-gate.ts` | **Fails, as required.** Pending surfaces: route 255, websocket 1, job 32, template 106 and administration 2, 396 in all. All 12 requirements are listed as pending (`warehouse-parity-and-freshness` is `blocked` in the ledger). `failures: []`, `productionReady: false` |
| 21 | Integrity greps | §4 | Clean |

## 2. Failure: `order-payments-browser-fixture-typecheck` (not fixed; regression from `6e2dcdfe`)

> **Resolved by W23 (`88833fad`, option 1).** The e2e/harness inserts into `orders`, `has_products`, `products` and
> `users` now spread `backend/tools/e2e/legacy-row-defaults.ts`, which writes each omitted NOT NULL column's stored
> value (DDL `DEFAULT`, else the non-strict implicit default) from `production-schema.json`. No casts and no
> exclusions. A loopback dump (empty `sql_mode`, fixed clock) of the seed, both harness sets and two fixture orders
> is identical before and after, apart from the operator's per-run PBKDF2 salt. `tools/e2e/tsconfig.json` and the new
> verifier check `e2e-tooling-typecheck` type-check all of `backend/tools/e2e`. Web Playwright passed 41/41 twice on
> one stack with 0 undeclared failures; desktop offline billing passed 12/12. `verify-project --mysql --browser
> --release` ran 87/87 checks, all passing including `browser-tests` (41/41); only `release-gate` fails, by design.
> Evidence: `backend/evidence/verification-88833fad-w23.json`.

**Symptom.** `tsc --noEmit -p frontend/tests/order-payments/tsconfig.json` exits 2 with six `TS2769 No overload
matches this call` errors, all of them in backend e2e tooling:
- `backend/tools/e2e/fixture-orders.ts:47` (`insert(Order)`): 26 NOT NULL columns are missing, such as `cod_charges`,
  `hl_charges`, `gifting_charges` and `payment_id`.
- `backend/tools/e2e/fixture-orders.ts:105` (`insert(HasProduct)`): 15 are missing, such as `salesperson_id`,
  `return_mode` and `amount_refunded_mode`.
- `backend/tools/e2e/seed.ts:195`, `:291`, `:320` and `:374`: the seed inserts. For example, products are missing
  `add_desc_id`, `is_crowd_funded`, `art_cut`, `is_cod` and 10 more.

**Root cause.**
1. That fixture tsconfig includes `../../e2e/checkout/order-payments.spec.ts`, and has done so since `b90b4be7`.
2. The W20 follow-up `6e2dcdfe`, merged in `719a66a6`, made that spec import `createUnpaidCounterOrder` from
   `backend/tools/e2e/fixture-orders.ts`, which in turn imports `seed.ts`.
3. `tsc` therefore now type-checks both backend tool files under the strict frontend options. Their inserts omit NOT
   NULL columns, which MySQL fills with implicit defaults under `sql_mode=''`. The Drizzle insert types require those
   columns.
4. W19 recorded this property of `seed.ts` and `harness-fixtures.ts` (`w19-report.md`, "Remaining gaps"). Until
   `6e2dcdfe`, no type-checked config reached those files.

**Why other checks did not catch it.**
- The app `tsc` (row 2) does not include `e2e/`.
- Playwright transpiles specs without type-checking them.
- `eslint` does not type-check.
- W19's verifier run (`ebc823f6`) predates `6e2dcdfe`.
- Neither the W20 nor the W21 report records a `verify-project` run after the follow-up.

**Why it was not fixed here.** There is no small mechanical fix:
- **Excluding the spec from the include list** would weaken an existing check.
- **A type assertion on the insert values** would hide the mismatch.
- **Making the inserts type-complete** means listing dozens of NOT NULL columns in each of six inserts, each with exactly the value
  MySQL defaults to today. That changes the seed both stacks use, and it needs an owner review.

**Effect.**
- The product code and the spec are fine. The spec passes 41/41 twice on one stack (row 10).
- `verify-project` stops before `browser-tests`, so its Playwright stage did not run in this run. Row 10 is the
  separate full run of that suite.
- **Owner:** e2e tooling (W20).
- **Fix options:**
  1. Make `seed.ts` and `fixture-orders.ts` type-complete, and add `backend/tools/e2e` to a backend typecheck config.
  2. Move `e2eDatabaseUrl`/`e2eProducts` into a dependency-free module, and type the fixture-order insert completely.

## 3. `tools/verify-project.ts --mysql --browser --release`

**Setup.** As in W18 §4, W22 did not touch the shared `/Users/rishabhbhatia/code/backend-pos-web`. Instead it used:
- a detached worktree of this branch at `b481fa91`, at `/private/tmp/claude-501/w22v/pos-rewrite-single-stack`, with
  `node_modules` symlinked to this worktree;
- a fresh clone of `backend-pos-web` checked out at `78d5b63` beside it;
- a symlink to `backend-sync-api` beside it.

`POS_VERIFY_MYSQL_URL=mysql://root@127.0.0.1:33922/pos_rewrite_integration`. The tool's fixed outputs,
`evidence/verification.json` and `parity/evidence/fulfillment-shipping/shipping-label.png`, landed in the throwaway
tree. The report was copied to the new file `backend/evidence/verification-b481fa91-w22.json`.

**Result.**
- Exit 1, `productionReady: false`, `interrupted: false`.
- `expectedChecks` 86, `completedChecks` 85.
- `changedInputs: []`. The source baseline (`78d5b63`, clean) and the rewrite baseline (`b481fa91`) are unchanged.

| Check(s) | Result |
|---|---|
| `backend-tests` | Pass: 220 files passed and 1 skipped; **1188 passed, 0 failed**, 18 skipped. The 18 are the 17 gated live tests plus the online-detail browser case, which `online-order-detail-native-app-browser-tests` runs and passes |
| `order-search-browser-tests`, `order-history-browser-tests`, `daily-reports-browser-tests` (W19 real-stack harnesses on 4420/4183), and their typecheck checks | **Pass.** Blocker 1 stays resolved |
| `daily-reports-browser-fixture-typecheck` (added by W19) | Pass |
| `order-payments-browser-fixture-typecheck` | **Fail** (§2) |
| All other checks | Pass (84 in all) |
| `browser-tests` (the Playwright suite) | **Not run** (the stop-after-failure rule). Covered by row 10 |
| `release-gate` | **Fails, by design** |

## 4. Integrity greps

| Grep | Result |
|---|---|
| `.py` / `.go` / `.php` (`find`, with `node_modules` and `.tmp` pruned; also `git ls-files`) | **0** |
| `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` and `CREATE TRIGGER` (case-insensitive; `backend/evidence` excluded) | Only the places W18 §5 allows: the snapshot helper `tests/helpers/production-schema.ts` (and its test-only `CREATE TRIGGER`); the documented `AUTO_INCREMENT` bumps in three administration MySQL tests; read-only `SHOW CREATE TABLE` in the snapshot and live tools; refused statements in `sql-guard.test.ts`; `production-schema.json`; docs and proposals; and the device-local SQLite in `frontend/electron/offline/database.ts`. There is **no executable production DDL** |
| `pos_rewrite_` in `backend/src` | 33 lines, **all comments**. 0 in `frontend/src` and `frontend/electron` |
| `DEMO_MODE` | **0 in code.** It appears only in history: `parity/w10-report.md`, `parity/w18-verification.md`, the PR draft, `evidence/routes.json` (a historical scope string) and `tools/administration/archival-workflow-receipt.json` (a historical receipt) |
| `: any`, `as any`, `<any>` and `any[]` in all tracked `*.ts`/`*.tsx` | **0** |
| Credentials: the read-only password and username markers | **0** in the tree; **0** in all history (`git log --all -S`) |
| Credentials: the PEM `BEGIN` marker | Two files. `global-bundle.pem` has 108 `CERTIFICATE` blocks, the public RDS CA bundle. The other hit is the prose of `backend/parity/w18-verification.md` §5, which names the marker; it is documentation, not key material. There is no `PRIVATE KEY` in any commit (`git log --all -S`) |

## 5. Release blockers 1–3 from W18

| Blocker | Resolved by | W22 evidence | Status |
|---|---|---|---|
| 1. Three stale `verify-project` browser harnesses | W19 (`ecc966a9`) | All three pass inside the verifier (§3) | **Resolved.** The verifier still stops before `browser-tests`, but now because of the new §2 failure |
| 2. Web e2e console errors and failed requests | W20 (`feb995c7`, `719a66a6`) | 0 unexpected console errors and 0 unexpected failed requests in two consecutive runs on one stack (row 10) | **Resolved** |
| 3. Flaky tests | W21 (`b481fa91`), W20 (`retail` offline reload) | Frontend 3/3 runs at 409/409; backend 2/2 at 0 failed; desktop 2/2 at 12/12; web 2/2 at 41/41 on one stack | **Resolved.** As W21 recorded, the cause of the DevTools disconnect in W18's desktop run 1 is still unconfirmed. Its teardown is now bounded (`closeApp()`), and it did not recur |

## 6. Documentation state

- `HANDOFF.md`, `CHECKPOINT.md`, `docs/pull-requests/pr-2-description.md` and the requirement notes in
  `backend/parity/release-coverage.json` were updated with these results. No requirement status changed.
- Still open from W18 §6:
  - the stale `remaining_code` entries in `tools/parity/source-surface-families.json`, which need an owner review;
  - `parity/order-history.md`, `order-search.md`, `order-browser-default-fixture-repair.md`, which still name the
    deleted `browser-check.mjs` files (W19).
- Resolved since W18: `OFFLINE_BILLING_MAX_MINUTES`/`_MAX_ORDERS` are now in `backend/.env.example` (`1ed3b130`).

## 7. How to reproduce

Use W18 §7, with these changes:
- Use port 33922 and data dir `.tmp/w22`.
- For the same-stack web runs:
  1. Start `E2E_MYSQL_URL=…/pos_rewrite_e2e E2E_WEB_ORIGIN=http://localhost:4173 node --import tsx tools/e2e/stack.ts`
     (backend) and `node node_modules/vite/bin/vite.js preview --host 127.0.0.1` (frontend).
  2. Run `npx playwright test` twice, with a config that spreads `playwright.config.ts` and sets
     `reuseExistingServer: true` on both web servers.
  3. Stop both with SIGTERM. The stack drops its schema and stops its Redis.
- For the desktop runs, set `E2E_DESKTOP_PORT_BASE=4610`.
- `E2E_NETWORK_AUDIT_FILE=<file>` records every declared failure as JSONL.

## 8. Conclusion

- **Product code.** Every product-code check passes on `b481fa91`. These are the static checks, the backend suites
  (twice), the frontend suites with browser gates (3 times), the web e2e (twice on one stack, with zero unexpected
  console errors or failed requests), the Electron shell and offline billing (twice), the builds, the unsigned
  package, the images and the container smoke.
- **Not met.** `verify-project` has one failing non-gate check, `order-payments-browser-fixture-typecheck` (§2). It
  is a test-tooling typing regression, not a product failure. Until it is fixed, the verifier does not reach its
  Playwright stage.
- **Release gate.** It fails, as it must: 396 surfaces and 12 requirements have no release evidence, and no
  provider, BigQuery report, live write path or worker has run against a live or sandbox service. **Production
  readiness is not claimed.**
