# W9: production schema freeze — final

Branch `w9/schema-freeze-final` from `16030d3d`. The rewrite now ships no migrations and executes no DDL. It uses
only the production tables captured in `tests/golden/schema/production-schema.json`, plus Redis. Nothing was run
against production. All MySQL checks used an isolated loopback MySQL 8.4 (`.tmp/mysql84`, port 33994, empty
`sql_mode`), which has since been stopped.

## 1. Deleted

**Migration machinery**
- `src/db/migrate.ts`, `migrations/0001_rewrite_state.sql`, and the runner, journal and readiness check in
  `src/db/migrations.ts`. That covered `applyMigrations`, `migrationPlan` and `assertMigrationsCurrent`, plus
  `pos_rewrite_schema_migrations` and `_steps`.
- The `migrate:plan` and `migrate:apply` scripts.
- The `/health/ready` migration dependency in `src/app.ts`. Readiness now checks only writer, primary and data
  connectivity.
- `tests/migrations.test.ts` and `tests/migrations.mysql.integration.test.ts`.
- The `backend/Dockerfile` copies of `migrations/` and every module `*.sql`. This includes the administration
  globs: packaging is not administration code.
- The `container-fixture.cjs` `packaged-migration-plan` check.
- The `deployment.md` migration plan, apply and journal steps. They are replaced by a short schema-freeze section.

**Rewrite table definitions**
| Definition | Tables |
|---|---|
| `src/db/rewrite-schema.ts` | `pos_rewrite_drafts`, `pos_rewrite_mutations` |
| `checkout/schema.ts` | `pos_rewrite_checkout_sessions` |
| `checkout/customers/schema.ts` | `pos_rewrite_customer_registrations`, `pos_rewrite_customer_registration_claims` |
| `fulfillment/schema.ts` | `pos_rewrite_fulfillment_effects` |

No `src` file imported any of these. `checkout/return-workflow/schema.ts` was already gone.

**Module migration SQL**
- `checkout/migrations/0016_product_feedback.sql`
- `application-links/migration.sql`
- `catalog-details/maintenance-migration.sql`
- `finance/migration.sql`
- `gift-card-batches/migration.sql`
- `operational-reports/{migration,scheduled-migration}.sql`

**Review DDL and index proposals** (ledger section C, #30, #31, #34 and #39)
- `parity/{customer-history,feedback-history}-projection-review.sql`
- `parity/bigquery-deployment/daily-publication-review.sql`
- `tools/order-history/publication.review.sql`
- `tools/customer-history/bigquery-fixtures.ts`, which only validated the deleted projection
- The non-production index benchmarks `tools/fulfillment/explain-local.mjs` and
  `tools/operational-reports/benchmark-flag-query.mjs`
- In `build-bigquery-deployment-plan.ts`: the rewrite-migration inputs, the deleted hyperlocal ALTER proposal and the
  two deleted projections

**Recovery claims.** `return-workflow/recovery-claims-migration.sql` was already deleted by W4, and nothing
references it. Claims live in Redis: `pos:exchange_recovery_claim:{store}:{order}:{line}:{claim}` and
`pos:exchange_recovery_claim_id:{claim}`, 30 days (`src/modules/checkout/return-workflow/state.ts:20-37`).

## 2. Live tables re-homed

None was needed: every deleted table was already unused in `src`.
- Drafts: `src/modules/drafts.ts:54-68`, `pos:draft:*`.
- Checkout sessions: `checkout/session-store.ts:7-9`.
- Registrations: `checkout/customers/service.ts:126-131`, `pos:customer_registration*`.
- `finance/alerts.ts` now posts Slack inline (`slackText` + `postSlackText`) and no longer writes `fulfillment_effects`.

## 3. Fixture helper

`tests/helpers/production-schema.ts` is the only code that turns DDL into tables.
- **`createProductionTables(session, tables)`** creates tables from the snapshot's `createTable`, verbatim, using
  table names or Drizzle tables. It sets `sql_mode=''` and `foreign_key_checks=0` for that session only, then
  restores both. A table that is not in the snapshot throws.
- **Other exports:** `createProductionSchema`, `productionColumns` (with a `unique` flag), `productionCreateTable`
  and `isProductionTable`.
- **`injectWriteFailure`** is test-only fault injection. It adds a `BEFORE` trigger that raises SQLSTATE 45000 on a
  disposable schema, and replaces the six inline triggers that rollback tests used.

Built on top of it:
- `tools/operational-reports/verified-mysql-fixture.ts` (`create`/`insert`) and
  `tools/administration/mysql-fixture.ts` (`legacyFixtureTableSql`, `legacyFixtureRecord`) now delegate to the
  helper.
- Where a row leaves a NOT NULL text column in a production UNIQUE KEY unset, the fixture gives it a distinct
  `fixture-N` value.

Every non-administration fixture now uses the helper, including the tools fixtures for dashboard, barcodes and model
accounts.

The two W2 inline changes are gone:
- The `gift_vouchers` unique key: production already has `voucher_code`.
- The `ix_pos_gv_history_order_voucher` index: there is no reference left in `src` or `tests`.

Other non-production DDL removed from tests:
- The `orders` date ALTER
- `uq_product_store`, the day-close and banking unique keys, `stores.slack_group_url` and `users.email`: all already
  in production
- The `inventory_calls` spy table, now an in-process spy
- The `pos_rewrite_*` epoch, outbox and check-in tables

Test changes that production keys forced:
- `device-handoff`: dropped the duplicate-email step. `pos_user.email` is unique.
- `hyperlocal-daily` and `shipping-label`: dropped duplicate `(order_id, has_product_id)` express rows, which the
  `unique_order_product` key rejects.
- Deleted two cases that only measured non-production index proposals: order-history "review index candidates"
  and order-search "candidate indexes EXPLAIN".
- The dashboard auth-epoch case now uses a password change. W3 removed epochs.

The cancellation test keeps a no-op `CREATE PROCEDURE pos_stock_syncer` stand-in for the production routine, so
that the bound `CALL` executes.

## 4. Grep results

- **`pos_rewrite_` in `backend/src`, outside `src/modules/administration`:** comments only.
- **`mysqlTable('pos_rewrite_…')`:** only `administration/{access-schema,schema}.ts`, which is W8's.
- **`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` and `CREATE TRIGGER` in `backend/` and `frontend/`**, with
  `backend/evidence/**` exempt. Remaining hits:
  - **The helper itself:** `tests/helpers/production-schema.ts`.
  - **Data and read-only references:**
    - the snapshot JSON
    - `SHOW CREATE TABLE` in `tools/schema/snapshot-production-schema.ts` and a comment in `tests/orm-metadata.test.ts`
  - **W8 (administration):**
    - `src/modules/administration/*.sql` (11 files)
    - `tests/administration/**` (7 files)
    - `tests/administration-history`: its access-control rewrite tables, which are W8's N1
  - **Documentation only, never executed:** index proposals in `parity/*-query-improvements.md`,
    `*-proposal(s).md`, `table-disposition.md` and `inventory-workbooks-query-plans.json`. Their owners did not ask
    W9 to edit them.
  - **`frontend/electron/offline/database.ts`:** device-local encrypted SQLite for the approved offline billing.
    This is not MySQL. See D3.
- **`*.sql` files left outside administration:** two select-only projections with no DDL,
  `parity/bigquery-deployment/legacy-report-export-projection.sql` (read by `raw-export-projection.test.ts`) and
  `tools/dashboard/publication-projection.sql`.

## 5. Test results

Backend checks:
- `npx tsc --noEmit -p .`: pass.
- `npx eslint .`: pass.
- `orm-metadata`: pass, with 0 mismatches.

Full `npx vitest run`:

| Mode | Passed | Failed | Skipped |
|---|---|---|---|
| Without MySQL | 663 | 0 | 401 |
| With every MySQL suite enabled | 972 | 3 | 89 |

`administration-history` was fixed after the full MySQL run. It now passes 9 of 9.

Before W9, the same environment had 55 failures: 26 files, including customer-profile (20), product-feedback (9),
the migration tests (5), admin (10), order-history (3) and customer-history (3), plus several suites that failed in
setup.

**Still failing with MySQL enabled**

| Suite | Cause | Owner / action |
|---|---|---|
| `customer-history/mysql` Latin1 case | Pre-existing: under an empty `sql_mode` this only warns | Existing; W7 recorded it |
| `catalog-details/mysql` detail oracle, `shipping-label` handler-context case | The golden captures are keyed to fixture rows that production unique keys forced to change (unique store phones, no duplicate express lines) | Recapture from pinned legacy |
| `operational-reports/{flash-sales,scheduled-data,order-report-mysql}` | Setup fails: they need `automated_refund_sic_logs`, `hyperlocal_availability_log` and `order_attributes`, which are not in the snapshot | D1 |
| `administration/{collections,inventory-jobs,mysql.integration}` | Setup fails: they read the deleted `operational-reports/migration.sql`, or create `uq_product_store`, which production DDL already has | W8 |

Frontend: not touched.

## 6. Administration items left for W8

- **The `src/db/migrations.ts` compatibility stub** keeps only `splitMigration` and the administration SQL path
  list, because `tests/administration/{collections,creator-authority,store-default-operators}` import them.
  Delete it with those imports.
- **Administration SQL files and `mysqlTable` definitions:**
  - `src/modules/administration/*.sql` (11 files)
  - `access-schema.ts` and `schema.ts` (`operatorCheckIns`)
- **Administration tests that still use inline DDL or deleted SQL:**
  - `inventory-jobs` and `mysql.integration`: the duplicate `uq_product_store`
  - `collections`: the deleted operational-reports SQL
  - `store-default-operators`: the deleted catalog maintenance SQL
  - inline DDL in `application-links`, `barcodes`, `model-accounts`, `terminal-directory` and `store-default-operators`
- **Fixtures that still load administration SQL:**
  - `tools/administration/model-accounts/fixture.ts` still loads `administration/{migration,access-migration}.sql`
  - `tests/administration-history` still creates `pos_rewrite_administration_registries` and loads
    `access-migration.sql`
  - Both are N1 access-control work.
- **`administration/barcodes` reset:** its `pos_rewrite_catalog_*` resets were removed together with the deleted
  catalog SQL.

## 7. Shared files and caller fixes

- **`src/app.ts`:** removed the import and readiness entry.
- **`backend/package.json`:** removed the two `migrate:*` scripts, which are W9-owned.
- **`tools/verify-project.ts`:** removed `backend/migrations` and `MIGRATION_MYSQL_TEST_URL`.
- **Not edited:** root `README.md` still describes the migration suites.

## 8. NEEDS USER DECISION

- **D1. Three production tables are missing from the snapshot:** `automated_refund_sic_logs`,
  `hyperlocal_availability_log` and `order_attributes`. Report SQL reads them, and `evidence/mysql-schema.json`
  lists them. Recapturing the snapshot to include them needs `POS_PROD_RO_MYSQL_URL`, which was not set. The other
  option is to accept these three suites as blocked until then. Without them, `flash-sales`, `scheduled-data` and
  `order-report-mysql` cannot run on snapshot-only DDL.
- **D2. Two golden captures need recapturing** from the pinned legacy source: the catalog detail oracle and the
  shipping-label handler context. Production keys forced their fixture rows to change.
- **D3. Device SQLite DDL.** Confirm that the approved Electron offline-billing SQLite schema
  (`frontend/electron/offline/database.ts`) is outside the MySQL schema freeze.
