# W18: Phase F full verification of the integrated single-stack tree

**Branch and heads.**
- Branch: `refactor/single-stack-schema-freeze`.
- Base: integration head `8a7530aa` (merge W14).
- W18 committed only mechanical test, tooling, doc and evidence changes. `git diff 8a7530aa..HEAD -- backend/src
  frontend/src frontend/electron backend/package.json frontend/package.json` is empty, so every result below was
  measured on the same product code.

**Environment.** Everything ran on loopback, and nothing connected to production.
- MySQL 8.4.11 with `--no-defaults --sql-mode=''`, on 127.0.0.1:33918, with its data dir under the worktree `.tmp/w18`.
- Private `redis-server` instances, spawned by the tests and the e2e stacks.
- Node 24.22.3 and Chrome 159.
- `POS_PROD_RO_MYSQL_URL` was unset throughout.
- Every service was stopped at the end.

## 1. Matrix

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Backend typecheck | `npx tsc --noEmit -p .` | 0 errors |
| 2 | Frontend typecheck | `npx tsc --noEmit -p .` | 0 errors |
| 3 | Electron typecheck | `npx tsc --noEmit -p electron/tsconfig.json` | 0 errors |
| 4 | Lint | `npx eslint .` (backend, frontend) | 0 problems, both |
| 5 | Backend vitest, every MySQL gate (26 URLs, as in `verify-project.ts`; `ORDER_DETAIL_BROWSER_TEST=true`; `ORDER_SEARCH_SOURCE_ROOT` = a git checkout containing the pin) | `npx vitest run --no-file-parallelism --maxWorkers=1` | 221 files: 220 passed, 1 skipped. 1204 tests: **1187 passed, 0 failed, 17 skipped**. The 17 are `tests/live-readonly/live-readonly.test.ts`, gated on the production URL. |
| 6 | ORM metadata | `tests/orm-metadata.test.ts` | Pass. **0 mismatches** (`orm-known-mismatches.json` is empty) against the 119-table snapshot |
| 7 | Route validation | `tests/route-validation.test.ts` | 7/7 pass; "**335/335 routes fully covered**" |
| 8 | Log redaction | `tests/observability/log-redaction.test.ts` | 4/4 pass |
| 9 | Frontend vitest, all 7 browser gates (`ADMINISTRATION`, `CHECKOUT_ACTIONS`, `COUNTER_BARCODE`, `CUSTOMER_PROFILE`, `OFFLINE_WORKSHEET`, `ORDER_COPY`, `PRODUCT_FEEDBACK`) | `npx vitest run` | 74 files, 409 tests: **408 passed, 1 failed** (flaky, §2.1) |
| 10 | Playwright web e2e on the real stack (`backend/tools/e2e/stack.ts`) | `E2E_MYSQL_URL=…/pos_rewrite_e2e npx playwright test --trace on` | **41/41 passed** in 1.7 min, including `electron.spec.ts` 2/2. Console errors and failed requests remain (§3) |
| 11 | Electron offline billing (`playwright.desktop.config.ts`), 12 scenarios | `E2E_MYSQL_URL=…/pos_rewrite_e2e_offline npx playwright test -c playwright.desktop.config.ts` | Run 1: 10 passed, **1 failed**, 1 not run (§2.2). Run 2: **12/12 passed** (6.2 min) |
| 12 | Backend production build | `npm run build` | Pass (`dist/server.js`, `dist/jobs/worker-main.js`) |
| 13 | Frontend production build | `npm run build` (typecheck, web bundle, `electron/dist/offline-billing.cjs`) | Pass |
| 14 | Electron package | `CSC_IDENTITY_AUTO_DISCOVERY=false POS_DESKTOP_URL=https://pos.example.test npx electron-builder --mac --dir --arm64` | Pass: `Souled POS.app`, 262 MB, ad-hoc signature, no Team ID. `offline-sqlite/prebuilds/darwin-arm64.node` is present. Warning: default icon |
| 15 | Container images | `docker build -t pos-rewrite-{backend,frontend}:verification {backend,frontend}` | Both build (backend `097be9f97778`, frontend `3ee8e72ff5d0`) |
| 16 | Container smoke | `node tools/smoke-containers.cjs` | **10/10** checks. New evidence: `backend/evidence/container-smoke-f600dd54-single-stack.json`. The tool's fixed output `container-smoke.json` was restored byte for byte |
| 17 | `tools/verify-project.ts --mysql --browser --release`, run 1 on `f600dd54` | §4 | exit 1; 86/87 checks ran; 6 failed plus the release gate. Evidence: `backend/evidence/verification-f600dd54-single-stack.json` |
| 18 | `verify-project`, run 2 on `a2382b4e` | §4 | exit 1, `productionReady: false`. 84 of 85 checks ran; **81 passed, 3 failed** (stale harnesses) plus the release gate. Evidence: `backend/evidence/verification-a2382b4e-single-stack.json` |
| 19 | Source-surface map | `node --import tsx tools/parity/build-source-surface-map.ts`, then `--check` | Regenerated (it was stale), then `--check` passes. 396 surfaces, 0 unmapped, 9 remaining-code groups, 0 certifications |
| 20 | Release gate | `LEGACY_SOURCE_ROOT=<pinned clone> node --import tsx tools/parity-gate.ts` | **Fails, as required.** Pending surfaces: route 255, websocket 1, job 32, template 106, administration 2 (396 in all). All 12 requirements pending, with no failures in the ledger itself |
| 21 | Live read-only production (primary agent, not W18) | `npm run test:live-readonly` | `backend/evidence/live-readonly-2026-11-19-r4.json`, MySQL 8.0.39: **16/16 paths**, schema **99/99** exact. 365 statements, 193 EXPLAINs, 0 locks, 0 refusals, 0 plan rejections, 3 plans bounded by LIMIT. The session reported `transaction_read_only=0`, so read-only was proved by SELECT/USAGE-only grants (`POS_PROD_RO_READONLY_PROOF=grants`) |

## 2. Failures and flakes, with root causes

### 2.1 Frontend: `tests/administration/workflows.test.ts` › "uploads a synthetic profile image … retries only attachment after a lost response"
- **Symptom.** `getByRole('status')` resolved to two elements: "Checking and attaching your image…" and
  "Image saved.".
- **Cause** (`frontend/src/components/private-images.tsx:88-95`, `:199-203`). `attach()` sets "Image saved." and
  then awaits `onAttached()` (the profile reload). `busy` stays true until `run()` finishes, so both status
  paragraphs render together for the duration of the reload.
- **Effect.** Under full-suite load the reload is slow enough for the strict locator to see both. The test passed
  3/3 in isolation.
- **Disposition.** This is a small UI inconsistency, not a mechanical failure. Clear `busy` before the message, or
  render one status paragraph. Not fixed; owner: administration UI.

### 2.2 Desktop: `e2e-desktop/offline-billing.spec.ts:414` "blocks billing after the offline time window" (run 1 only)
- **Sequence.** The backend restarted with `OFFLINE_BILLING_MAX_MINUTES=1`, went offline, and billed one sale
  (ok). Then, 39 s into `page.waitForTimeout(62000)`: `Target page, context or browser has been closed`. Scenario
  O11 did not run.
- **Teardown.** The worker teardown then hit its 300 s timeout, and backend requests from the app continued
  afterwards.
- **Rerun.** Run 2, with an identical command and fresh state, passed 12/12, including this scenario (1.8 min).
- **Cause.** Not reproduced, so the root cause is **unconfirmed**. The hung teardown suggests the Electron main
  process was blocked rather than exited. A modal `dialog.showErrorBox` in `electron/main.cjs:160-166` would do
  that, but this is a hypothesis.
- **Prior history.** W17 also recorded one unexplained flaky run.
- **Disposition.** Owner: desktop. Not changed.

### 2.3 `verify-project` run 1 failures
See §4.

## 3. Web e2e console errors and failed requests (target: zero, not met)

**Method.** Every test ran with `--trace on`. `trace.trace` and `trace.network` were parsed from all 41 traces.
- **Page errors (uncaught exceptions): 0.**
- **Console errors: 180.**
- **Failed or non-2xx requests: 169.**

The parser was a scratch script; its summary is reproduced here.

| Category | Requests | Console errors | Root cause | Owner / action |
|---|---|---|---|---|
| A. Pre-login probes | 64 | 64 of the 65 401 lines | `GET /api/v1/auth/sessions/current` and `GET /api/v1/auth/challenges/current` answer 401 before sign-in. This is the auth contract (S50), and Chrome logs each 401 as a console error. Seen on every sign-in in every spec | Auth owner. Answering `200 {authenticated:false}` would change the contract. Already listed by W14 |
| B. Intentional negative cases, aborted or offline requests | 20 + 35 | 36 | The specs drive them on purpose. Examples: unknown order 404s (`order-link`, `discount-approval`), "User Not Found." 404 (`customers`), 409 conflicts (`clearance`, `application-links`), 422 exchange refusal, 400 password validation (`profile`), 403 invoice and daily-report scope, 503 uncertain submission (`checkout-recovery`), `setOffline` (`retail`), `page.route` aborts (`returns`, `ERR_BLOCKED_BY_CLIENT`) and in-flight requests cancelled by reloads (`-1`) | None; the spec asserts each one. Includes the `checkout-recovery` invoice preview 404 for mocked order 8801, a fixture-only order |
| C. Fully mocked wallet spec | 39 | 39 | `e2e/checkout/wallet-adjustments.spec.ts` routes every `/api/v1/**` through a fixture and answers anything unmocked with `503 UNEXPECTED_FIXTURE_REQUEST`. It does not mock `/operators/me/check-in`, `/stores/1/notifications` or the notifications WebSocket, which then fails "HTTP Authentication failed" | Spec owner: mock these three, or allow them |
| D1. Notifications for a store the operator is not checked into | 10 | 10 | After the store selector switches to store 2 (`order-link`, `product-feedback`), the notifications panel calls `GET /stores/2/notifications` and opens the stream. The server answers 403 `CHECK_IN_REQUIRED` (S56) | Frontend: do not poll notifications for a store without check-in |
| D2. Invoice preview sandbox | — | 30 | "Blocked script execution in '…/invoices/store/preview' because the document's frame is sandboxed and the 'allow-scripts' permission is not set". The preview iframe is `sandbox="allow-same-origin allow-modals"` (`frontend/src/pages/invoice-documents/document.tsx:317`) with CSP `script-src 'none'` (S20), and the page calls `contentWindow.focus()`/`print()` on it (`:233-234`). Printing still works (the invoice specs pass). The exact trigger was not isolated | Invoice owner: decide whether to accept the noise or print differently |
| D3. Logout | 1 | 1 | After logout, `retail-operator-logout` still issues `GET /api/v1/stores` and gets 401 | Frontend: cancel the store refresh on logout |

## 4. `tools/verify-project.ts --mysql --browser --release`

**Setup.** The verifier requires `../backend-pos-web` to be a clean checkout at the pin. The shared
`/Users/rishabhbhatia/code/backend-pos-web` is at `62d6ce1`, and it was not touched. Instead:
- a detached worktree of this branch at `/private/tmp/claude-501/w18v/pos-rewrite-single-stack`, with
  `node_modules` symlinked to this worktree;
- a local clone of `backend-pos-web` checked out at `78d5b63` beside it.

The tool always writes `backend/evidence/verification.json` and refreshes
`parity/evidence/fulfillment-shipping/shipping-label.png`. Both writes landed in the throwaway worktree, and the
report was copied to a new file here.

**Run 1** (`f600dd54`, `backend/evidence/verification-f600dd54-single-stack.json`)
- **Summary.** Exit 1, `productionReady: false`, 87 expected, 86 run, `changedInputs: 0`, source and rewrite
  baselines unchanged.
- **Not run.** `browser-tests` (the Playwright suite). The tool stops before it once any check has failed; row 10
  covers it.
- **Failures:**

| Check | Root cause | Disposition |
|---|---|---|
| `backend-tests` | `tests/stock-projection.mysql.integration.test.ts` reads `../../backend-sync-api/new-src/api/models/inventoryModel.ts` (`tools/stock-projection/source-oracle.ts:11`), a sibling repository that is absent beside the throwaway worktree. 1174 passed, 18 skipped, 0 failed tests; 1 file failed at import | Environment. It passes in this worktree (row 5). A symlink was added for run 2 |
| `legacy-delivery-browser-tests`, `legacy-delivery-lifecycle-browser-tests` | `ERR_MODULE_NOT_FOUND`: `fe5dfb93` deleted `frontend/tests/legacy-fulfillment/{browser-check,lifecycle-browser-check}.mjs`, but the verifier and `run-browser-fixture.mjs` still registered them | **Fixed** (mechanical, `a2382b4e`) |
| `order-search-browser-tests` | Timeout waiting for "View order 9007199254740993". The standalone mocked-API harness `frontend/tests/order-search/browser-check.mjs` was last changed in `426b5970` (18 Nov). Since then, 33 commits changed order-history and its UI and API (W5 legacy banner and detail, W12 strict validation), so the harness no longer matches the page | **Not fixed (substantive):** the harness needs re-authoring against the current contract. The real-stack specs `order-link`, `order-default-ranges` and `retail` cover these pages and pass |
| `order-history-browser-tests` | Same pattern ("View order 501"). Harness last changed in `a456b7a8` (18 Nov); 35 later commits | Not fixed (substantive), as above |
| `daily-reports-browser-tests` | Timeout in `selectOption` ("did not find some options"). Harness `frontend/tests/reports/browser-check.mjs` was last changed in `ba05caf5`; 24 later report and UI commits | Not fixed (substantive). Real-stack `daily-report.spec.ts` passes |
| `release-gate` | Required to fail (§1 row 20) | By design |

**Run 2** (`a2382b4e`, after the legacy-delivery fix and with the sync-api sibling symlinked):

- **Summary.** Exit 1, `productionReady: false`, 85 expected, 84 run, 81 passed, `changedInputs: 0`, source and
  rewrite baselines unchanged. Evidence: `backend/evidence/verification-a2382b4e-single-stack.json`.
- **`backend-tests` now passes:** 220 files passed and 1 skipped; 1186 tests passed, 0 failed and 18 skipped. The
  18 are the 17 gated live tests, plus the online-detail browser case, which the separate
  `online-order-detail-native-app-browser-tests` check runs and passes.
- **`legacy-delivery-*` checks** are gone (`a2382b4e`).
- **Still failing:** `order-search-browser-tests`, `order-history-browser-tests` and `daily-reports-browser-tests`,
  the stale harnesses described above. Because they fail, `browser-tests` (Playwright) is again not run by the
  tool; row 10 is the separate full run of that suite.
- **Release gate:** fails.

**Mechanical fixes made by W18**, one commit each:

| Commit | Fix |
|---|---|
| `7466be6f` | `tools/operational-reports/build-bigquery-deployment-plan.ts` still printed `rewriteMigrations.length` after `132403e5` removed it (TS2304 in `tsconfig.bigquery.json`) |
| `7d2976d8`, `a3618584`, `c243cf37` | Type-only fixes for the fixture tsconfigs (`noUncheckedIndexedAccess`) in `tests/legacy-order-status/transport.test.ts`, `tests/legacy-fulfillment/legacy-golden.test.ts` and `tests/global-vouchers/service.mysql.test.ts`. Assertions are unchanged, and each file passes |
| `5d0bf44f` | Verifier checks whose targets were deleted with their features: ecommerce-sync and parent-store-import fixtures, the customer-contacts browser fixture and test, the whole-order-status receiver browser checks, and the group-bulk and gift-card-batch browser tests |
| `f600dd54` | The verifier now passes `E2E_MYSQL_URL` (loopback, `pos_rewrite_e2e`) to its Playwright check. It was required since W10 but stripped by the sanitised environment |
| `a2382b4e` | The deleted local-delivery browser fixtures (above) |

Before these fixes, a sweep of all 60 verifier typecheck configs found 5 missing configs and 4 failing configs.
After them, all remaining configs pass.

## 5. Integrity greps

| Grep | Result |
|---|---|
| `find . -path '*/node_modules' -prune -o \( -name '*.py' -o -name '*.go' -o -name '*.php' \) -print` | **Empty** (0) |
| `CREATE TABLE` / `ALTER TABLE` / `CREATE INDEX` / `CREATE TRIGGER` (case-insensitive, `backend/evidence` excluded) | Only allowed places. **Snapshot helper:** `tests/helpers/production-schema.ts`, including `CREATE TRIGGER` in `injectWriteFailure`, the documented test-only technique. **`AUTO_INCREMENT` bumps:** `tests/administration/{barcodes/mysql,model-accounts/service.mysql,mysql.integration}.test.ts`, documented by W10. **Read-only:** `SHOW CREATE TABLE` in the snapshot and live tools, and refused-statement cases in `tests/live-readonly/sql-guard.test.ts`. **Data:** `production-schema.json` (119). **Docs and proposals:** `backend/parity/*-query-*.md`, `table-disposition.md`, `inventory-workbooks-query-plans.json`, root `improve-query.md`, the plan, and W-reports. **Device-local SQLite:** `frontend/electron/offline/database.ts`. No executable production DDL |
| `pos_rewrite_` in `backend/src` | 33 lines, **all comments**; a regex for non-comment lines finds none |
| `DEMO_MODE` | Code: none. Hits only in `parity/w10-report.md` (history) and `tools/administration/archival-workflow-receipt.json` (historical receipt) |
| `: any` / `as any` / `<any>` / `any[]` in `backend/src`, `frontend/src`, `frontend/electron` | None |
| Every route has zod | `route-validation`: 335/335 |
| Credentials | The two credential markers supplied by the primary agent (not repeated here): 0 hits in the tree, and 0 in all git history (`git log --all -S`). `-----BEGIN`: only `global-bundle.pem`, 108 public `CERTIFICATE` blocks (the RDS CA bundle), and no `PRIVATE KEY` anywhere in history. MySQL URLs with credentials: only synthetic ones (`synthetic:synthetic@`, `user:pass@`, `root@` loopback) and `<ro-user>:<password>` placeholders in `parity/live-readonly.md`. W18 was not given the read-only username prefix, so the primary agent should also run `git grep -n '<prefix>'` itself; a scan for `readonly_`/`ro_`-style account names found nothing. **No real credential found** |

## 6. Documentation state found during verification

- **Source-surface map.** It was stale at `8a7530aa`, and W18 regenerated it. Several `remaining_code` entries in
  `tools/parity/source-surface-families.json` look completed by later workstreams. They are not edited here,
  because they need an owner review:

  | Family | Completed by |
  |---|---|
  | `fast-cash` | W14 restored the Fast Checkout dialog |
  | `orders-read`, type-8 guard | S35 on the server, W4 follow-up |
  | `legacy-vinculum-status` | `91980604`, legacy sync-API push |
  | `customer-contacts` | `970ca9f9` |
  | `customer-website-handoff` | W5 C23 |
  | `ecommerce-inventory-sync` | W8 inline `syncproduct` |
  | `legacy-paid-reversal` | W4 S32 |

- **Security decisions.** `security-decisions.md` S35 still says "To implement (W4 follow-up)". The W4 follow-up
  report records it as implemented (`692e25bb`, `d034c9b3`). The primary agent owns that file.
- **Release coverage.** `release-coverage.json` named 20 deleted Python and native harness paths. W18 replaced
  them with the W15 golden tests and added the `sso-integration` entry, which is obsolete because SSO is deleted.
  All statuses remain pending or blocked.
- **Environment docs.** `OFFLINE_BILLING_MAX_MINUTES` and `OFFLINE_BILLING_MAX_ORDERS` are read in
  `src/modules/offline-sync/options.ts`, but they are not in `backend/.env.example`.

## 7. How to reproduce

```sh
export PATH=/Users/rishabhbhatia/.npm/_npx/c9870267d9e0f935/node_modules/node/bin:$PATH
M=/opt/homebrew/opt/mysql@8.4/bin; D=$PWD/.tmp/w18/mysql; mkdir -p $D
$M/mysqld --no-defaults --initialize-insecure --datadir=$D/data
$M/mysqld --no-defaults --datadir=$D/data --port=33918 --bind-address=127.0.0.1 \
  --socket=/private/tmp/claude-501/w18.sock --mysqlx=OFF --sql-mode='' --pid-file=$D/mysqld.pid &
# backend: export every *_MYSQL_*URL from verify-project.ts against mysql://root@127.0.0.1:33918/<schema>,
# plus ORDER_DETAIL_BROWSER_TEST=true and ORDER_SEARCH_SOURCE_ROOT=<git checkout containing 78d5b63>
cd backend && npx vitest run --no-file-parallelism --maxWorkers=1
cd ../frontend && npm run build && ADMINISTRATION_BROWSER_TESTS=true … npx vitest run
E2E_MYSQL_URL=mysql://root@127.0.0.1:33918/pos_rewrite_e2e npx playwright test
E2E_MYSQL_URL=mysql://root@127.0.0.1:33918/pos_rewrite_e2e_offline npx playwright test -c playwright.desktop.config.ts
# verify-project: from a worktree whose sibling ../backend-pos-web is a clean clone at 78d5b63
# (and ../backend-sync-api present), POS_VERIFY_MYSQL_URL=mysql://root@127.0.0.1:33918/pos_rewrite_integration
node --import tsx tools/verify-project.ts --mysql --browser --release   # then copy evidence/verification.json to a NEW file
$M/mysqladmin -h127.0.0.1 -P33918 -uroot shutdown
```

## 8. Conclusion

- **Product code.** Static checks, unit and MySQL integration tests, the real-stack web e2e, the Electron offline
  billing scenarios, the builds, the package, the images and the container smoke all pass on the integrated
  product code. There are two flaky tests, with causes in §2.
- **Not met.**
  - The zero-console-error target (§3).
  - Three stale standalone browser harnesses (§4).
- **Release gate.** It fails, as it must: 396 surfaces and 12 requirements have no release evidence, and no
  provider, BigQuery, write path or worker has run against a live or sandbox service. **Production readiness is
  not claimed.**
