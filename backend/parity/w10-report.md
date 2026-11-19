# W10 report: demo mode removal

Branch `w10/demo-removal`, from integration head `43613a75`. AGENTS.md ("Removed features")
deletes demo mode. This workstream removes every demo code path, and moves every test, tool
and browser fixture that used demo mode onto real dependencies.

## 1. What was removed

### Backend (`backend/src`)
- **Config.** `DEMO_MODE` is gone from `config.ts`, together with its production refusal and its
  "local dependencies only" loop. `MYSQL_PRIMARY_READER_URL` is now always required, so there is
  no database-free startup.
- **Demo modules.** `modules/demo.ts` (synthetic catalogue, orders, drafts and `demoUser`),
  `auth/demo-session.ts` (synthetic account reader) and `modules/order-history/search/demo.ts`
  (synthetic order search) are deleted.
- **Demo login.** `auth/routes.ts` no longer has the `demoUser` option, the
  `POST /api/v1/auth/demo-sessions` route, the demo principal shortcut in the session `preHandler`,
  the "password sign-in unavailable" refusal, or the demo exemption from check-in cleanup on
  logout. `GET /api/v1/auth/capabilities` returns `{ "password": true }`. The event catalogue
  entry for `demo-sessions` is removed (`observability/events.ts`).
- **In-process demo Redis.** `src/redis/memory.ts` moved to `tests/helpers/memory-redis.ts`. It is
  now a test fake that tests inject. `app.ts` uses `REDIS_URL`, or `unavailableRedisPort()`.
- **`app.ts`.** All demo branches are removed: the read-only `DEMO_READ_ONLY` gate, the synthetic
  daily-report rows, `/health/ready` `mode: 'demo'`, the demo services, `memoryOrderRedis`, the
  demo order search, and the `demoStores` finance option. Every adapter (S3 profile, media and
  store images, settings delivery, product sync, device-handoff store, whole-order status
  options) is now built from its explicit config, exactly as the non-demo branch already did.
- **`config.DEMO_MODE` branches deleted; the real branch kept** in:
  - `jobs/handlers.ts`, `jobs/module-runtime.ts`
  - `db/stock-projection/options.ts`
  - `modules/administration/{ephemeral-runtime,import-storage,jobs,media-storage,private-s3-client,product-sync,settings-adapters,slack-provider}.ts`
  - `modules/application-links/{provider,service,index}.ts`
  - `modules/catalog-details/maintenance-transports.ts`
  - `modules/checkout/{cancellations/routes,order-copy/routes,state-store}.ts`
  - `modules/customer-insights/checkout-scope.ts`
  - `modules/customer-website-handoff/{options,service}.ts`
  - `modules/finance/index.ts`
  - `modules/gift-card-batches/{delivery,jobs,storage}.ts`
  - `modules/invoice-documents/index.ts`
  - `modules/legacy-fulfillment/{gateway,index}.ts`
  - `modules/offline-sync/routes.ts`
  - `modules/operational-reports/{export-storage,scheduled-data}.ts`
- **Signatures.** Functions whose only config use was `DEMO_MODE` lost that parameter:
  `createCustomerApplicationProvider`, `createStaffApplicationPackage`, `websiteBase` and
  `createGiftCardBatchDelivery`. Their callers were updated.
- **`db | null` made non-null.** `readCatalogBarcode`, `readCatalogStockLocations` and
  `registerCatalogStockLocations` now take `Databases`. The database-free barcode filter path is
  deleted.
- **Production guards unchanged.** Production still refuses sandbox OTP delivery
  (`LOGIN_OTP_DELIVERY=sandbox`, W3 S15), plaintext MySQL, a missing `REDIS_URL`, insecure
  cookies and the example secret. The demo-only "remote endpoint refused" checks are gone,
  because demo mode is gone. The non-demo loopback rules (http only to loopback outside
  production) are unchanged.

### Frontend (`frontend/src`)
- The login page has no "Explore demo workspace" button and no demo session call. `login()` takes
  the form only.
- `capabilitiesSchema` has no `demo` field.
- `app.tsx` no longer queries capabilities to hide native features in demo. The notifications
  panel, the check-in link (`WorkspaceContext`, whose `native` prop is removed), fulfilment
  expiry alerts and the day-close reminder are always enabled under their real conditions.
- The `.demo-note` CSS is removed.

### Docs
- `backend/.env.example` no longer has `DEMO_MODE`. It now states that `MYSQL_PRIMARY_READER_URL`
  is always required.
- The README local-development section and `deployment.md` no longer describe a demo mode.
- `backend/tools/administration/archival-workflow.md` no longer mentions `DEMO_MODE=false`.
- Historical parity notes that described demo behaviour as current (`order-messages.md`,
  `rejected-return-repairs.md`, `w3-report.md`) now say it was removed.

## 2. How the tests moved

| Kind of test | Before | Now |
| --- | --- | --- |
| Unit tests that only needed a config | `DEMO_MODE: 'true'` to skip the MySQL URL requirement | `MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused'`, the existing convention for tests that never touch MySQL. If one did query it, it would fail loudly; nothing is faked. About 45 files. |
| Typed adapter configs | `{ DEMO_MODE: false }` | The key is removed. Functions that lost their config parameter are called without it. |
| Tests that used `demoUser` as a principal fixture | `modules/demo.ts` | `tests/helpers/principals.ts` (`syntheticOperator`, `syntheticSessionAccount`, `singleAccountReader`), injected. Used by `device-handoff`, `motivational-quotes`, `trace-context` and `sessions`. |
| Whole-app tests that used the demo login | `POST /api/v1/auth/demo-sessions` and demo services | `tests/helpers/app-stack.ts`. It creates a disposable `pos_rewrite_app_stack_<random>` schema on loopback MySQL with every production table from `createProductionTables`, adds a small synthetic seed, injects the in-process auth Redis fake, and signs a real session cookie. Gated by `APP_STACK_MYSQL_TEST_URL` (schema `pos_rewrite_app_stack_test`, now in `verify-project.ts`). Used by `api`, `sessions` (logout revocation), `logging`, `catalog-barcode` (route and exact-match reads) and `reports/store-options`. |
| Redis | `src/redis/memory.ts`, also selected at runtime by demo | `tests/helpers/memory-redis.ts`, injected only. A loopback `redis-server` is still used where `auth-redis.ts` finds one. |
| Administration MySQL tests with hand-written DDL | `CREATE TABLE`/`ALTER TABLE` approximations | The snapshot helper (`createProductionTables` / `verifiedMysqlFixture`). See below. |

**Demo-only assertions deleted** (each asserted a behaviour that only existed in demo mode):
- the demo refusals of settings cache, Slack OAuth, product sync, inventory transport, report
  export storage and system stock;
- the synthetic order-search contract (`orderTypes: ['ST']`, rows 6008/6007, and `orderType: 'N'`
  refused as 400);
- the `DEMO_READ_ONLY` financial refusal;
- the database-free demo barcode resolution, now covered on MySQL instead.

**Administration DDL (step 4).**
- `application-links.mysql.integration`: snapshot tables replace the hand-written
  `pos_to_app_logs` table.
- `inventory-jobs.mysql`: the redundant `ADD UNIQUE KEY uq_product_store` is removed. It already
  exists in production and made the suite fail at baseline.
- `mysql.integration`:
  - the hand-written `pricelist` table and the `product_store`, `deliverable_pincodes` and
    `pos_user` ALTERs are removed;
  - the SIGNAL trigger goes through `injectWriteFailure`, with a comment;
  - the `AUTO_INCREMENT` big-ID bump is kept, with a comment;
  - date expectations now follow production whole-second TIMESTAMP columns.
- `barcodes/mysql`: the trigger goes through `injectWriteFailure`; both `AUTO_INCREMENT` bumps
  are kept, with comments.
- `model-accounts/service.mysql`: the `AUTO_INCREMENT` bump is kept, with a comment.
- `terminal-directory.mysql`: the utf8mb4 ALTERs are removed, so the test runs on the
  production latin1 columns with the same assertions.
- `store-default-operators.mysql`: the "ambiguous identities" case is deleted. It dropped the
  production unique index on `contact_email` to create a state that the production schema
  cannot hold.

## 3. End-to-end stack

`backend/tools/e2e/`:
- **`seed.ts`.**
  - Refuses any non-loopback MySQL URL and any schema not named `pos_rewrite_e2e*`.
  - Drops and recreates that schema, then builds every production table with
    `createProductionTables`.
  - Seeds synthetic rows through the drizzle ORM: stores 1–2, counters, operator 900001
    (`e2e-operator`, Django `pbkdf2_sha256` hash, role 4, stores 1 and 2), 12 products with
    `product_store` and `products_gs1` rows, order and payment statuses, synthetic customers,
    and orders 6001–6008 with `order_store` and `has_product` rows.
  - Uses example.test emails and 90000000xx phones only.
  - Exports `seedE2e` and `createE2eDatabase`, and has a CLI.
- **`fakes.ts`.** One loopback HTTP server with `/api-v2/`, `/payments/`, `/sms/`, `/email/`,
  `/slack/` and `/product-sync/` prefixes. It records method, adapter and path only.
- **`stack.ts`.** Seeds the schema, starts a private loopback `redis-server`, starts the fakes and
  spawns the real `src/server.ts` with a scratch environment (no `.env`):
  - `NODE_ENV=test`, `REDIS_URL` set, `MYSQL_ALLOW_LOCAL_PLAINTEXT=true`;
  - API-v2 and payment base URLs point at the fakes;
  - `LOGIN_OTP_DELIVERY=sandbox` plus the legacy `LOGIN_FIXED_OTP_*` for user 900001 only;
  - `DAY_CLOSE_ENABLED_STORE_IDS=0`, so the blocking day-close reminder stays off the seeded
    stores.

  SIGTERM stops everything and drops the schema.
- **Adapters that need HTTPS.** Login SMS, email and Slack only accept HTTPS endpoints, so they use
  the existing in-process sandbox transport, chosen by explicit config. Production still refuses
  sandbox delivery (S15).

**Playwright.** `frontend/playwright.config.ts` starts `stack.ts` (readiness:
`/health/ready`) and `vite preview`. It requires `E2E_MYSQL_URL`. `frontend/e2e/support/login.ts`
signs in through the real password step, then the OTP and store step. `login.spec.ts` gets its
real session through the actual password and verification endpoints.

Run it:
```sh
# loopback mysqld 8.4 with empty sql_mode, e.g. on 127.0.0.1:33710; redis-server on PATH
cd frontend && npx vite build
E2E_MYSQL_URL=mysql://root@127.0.0.1:33710/pos_rewrite_e2e npx playwright test
```

**Container smoke** (`tools/smoke-containers.cjs`, `tools/container-fixture.cjs`):
- A `mysql:8.4` container is seeded from the host through a temporary loopback-published port.
  The seed network is then disconnected.
- `redis:7` and the backend share MySQL's network namespace, so both dependencies are loopback.
- The fixture logs in with the real password and fixed OTP, then checks catalog, draft, role and
  origin isolation.

**CI** (`desktop-platforms.yml`): macOS installs `mysql@8.4` and `redis` with Homebrew, starts a
loopback mysqld and exports `E2E_MYSQL_URL` before `npm run test:e2e`. Windows has no native
`redis-server`, so the Playwright step now runs on macOS only.

## 4. Results

| Check | Result |
| --- | --- |
| Backend `tsc --noEmit -p .` | Pass |
| Backend `eslint .` | 1 error, already present at the base commit: `tools/administration/model-accounts/fixture.ts`, unused `readFileSync`. All changed files are clean. |
| Frontend `tsc` / `eslint .` | Pass |
| Backend vitest, without MySQL | 152 files passed, 47 skipped; 649 tests passed. The base commit had 1 failing file, from a relative path outside the repo. |
| Backend vitest, all MySQL suites enabled (loopback 8.4, `--no-file-parallelism`) | 194 files passed, 5 failed; 1032 tests passed, 11 failed. All but one failure are also failing at the base commit (`collections` ×7, `catalog-details`, `customer-history` Latin1, `shipping-label`); the base commit had 10 failing tests. The new failure is `administration/mysql.integration` `exclusivePrice` `"799"` vs `"799.00"`, exposed once production FLOAT `pricelist.price` replaced the hand-written DDL. `inventory-jobs` and `administration/mysql.integration` now run; both failed at suite level before. |
| Frontend vitest | 56 files passed, 15 skipped; 292 tests passed. |
| Playwright on the real stack (Chromium, Electron specs not run) | 22 passed, 13 failed. 12 of the failures also fail on the demo backend at the base commit (cashier-shortcuts ×2, customers ×2, discount-approval, exchange, gift-card, invoice, checkout-recovery ×2, order-default-ranges explicit filters, returns); they come from spec and UI drift, not from this change. The one new failure: `retail` "desktop web flow" cannot click "Close order" on the real, long order-detail dialog (the button is outside the viewport); the short demo detail never showed this. `order-payments.spec.ts` was excluded because it does not load at the base commit either (`recordedLegacyInputSchema` is no longer exported). |
| Container smoke (real MySQL and Redis) | Passed, with a freshly built backend image and the existing frontend verification image. All 10 checks passed. The frontend image does not build at the base commit (native `better-sqlite3-multiple-ciphers` needs Python). The evidence file it wrote was restored, so `backend/evidence/**` is unchanged. |

## 5. Leftovers

- **Final greps.**
  - `git grep -i demo` in `backend/src` and `frontend/src` finds only the legacy
    `SLACK_DEMO_URL` "demo" Slack channel in scheduled reports (`scheduled-domain.ts`,
    `scheduled-options.ts`, `scheduled-routes.ts`; legacy `POSAdmin/settings.py:511`,
    `helpers.py:1172`). This is a legacy feature, not demo mode.
  - `DEMO_MODE` remains only in historical evidence JSON (tool receipts,
    `parity/evidence/**`, `source-surface-map.json`).
- **NEEDS DECISION.** `exclusivePrice` formatting for FLOAT `pricelist.price`. This belongs to the
  `catalog.ts` owner (W11).
- **No production-fixture coverage.** The `STORE_DEFAULT_OPERATORS_AMBIGUOUS` safeguard no longer
  has a production-schema fixture.
- **Order-detail dialog.** In `retail.spec.ts`, "Close order" is unreachable on a long real order
  detail. This is a frontend dialog layout issue for the UI owner.
- **Pre-existing failures.** The 12 Playwright failures and `order-payments.spec.ts` already failed
  at the base commit and need their owners.
- **Not run here.**
  - The Electron e2e specs (they need the desktop build).
  - The frontend container image build (fails at the base commit, as above).
  - A Windows e2e runner. There is no Windows-native Redis, so e2e is macOS-only in CI.
- **Kept in `src` as injectable fakes.** `memoryOrderRedis` and `memoryStateStore` stay in `src`
  as injectable test fakes. The non-production in-memory fallbacks without `REDIS_URL`
  (`configuredStateStore`, `createModuleRuntime`, `administrationEphemeralStore`) are existing
  development fallbacks, not demo switches; production already refuses them.
- **Flaky under load.** `tests/auth/login-flow.test.ts` failed once in a fully parallel run (401
  vs 403) and passes on its own.
- **Shared-file edits.** `src/app.ts`, `src/config.ts`, `src/observability/events.ts`,
  `backend/.env.example`. Each edit only removes demo code.
