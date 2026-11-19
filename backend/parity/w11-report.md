# W11 report: Phase E1, MySQL through the Drizzle query builder

Branch `w11/orm-only`, from integration head `43613a75`. The work was split across three
parallel agents with exclusive file ownership:
- primary: everything outside the two modules below, plus `legacy-schema.ts` and the parity docs;
- CAT fork: `catalog-details/**` and `catalog.ts`;
- OPS fork: `operational-reports/**`.

Exceptions are documented in `backend/parity/orm-exceptions.md`, which lists every remaining
site with `file:line`.

## 1. Conversion counts

The task grep is `grep -rnE 'sql\`|\.execute\(|\.query\(' src`. Remaining sites are either
exceptions (E) or typed expressions (T); both are explained in `orm-exceptions.md`.

| module | before | after | what is left |
|---|---:|---:|---|
| catalog-details | 51 | 6 | T only. 8 `.execute` → 0 |
| catalog.ts | 3 | 2 | T only |
| operational-reports | 57 | 26 | E3 (order-transactions, flash-sales, scheduled oracle) + T |
| administration | 35 | 23 | E2 (2 procedures) + T (import-job bound values, literals, CAST/COALESCE) |
| order-history | 18 | 10 | T (CAST, `LIKE … ESCAPE`, bound flags, literal) |
| dashboard | 8 | 3 | T (scalar subqueries built with QueryBuilder, `select 1` in `exists`) |
| checkout | 8 | 4 | E2 (1 procedure) + T (batched CASE update) |
| finance | 6 | 3 | E3 (feed template) |
| daily-report-corrections.ts | 4 | 0 | none |
| fulfillment | 3 | 0 | none |
| db (pools, stock-projection) | 3 | 2 | E5 (session setup) |
| auth | 1 | 0 | none |
| reports.ts | 9 | 9 | E3 (daily report legacy templates) |
| application-links | 3 | 3 | E7 (column defaults) |
| gift-card-batches / administration-history | 1 / 1 | 1 / 1 | T (CAST, `DATABASE()`) |
| app.ts / warehouse.ts | 1 / 1 | 1 / 1 | E6 readiness probe / E1 BigQuery |
| **total** | **213** | **95** | 42 exception lines + 53 typed expressions |

**Statement executions.** `.execute(` and `.query(` sites fell from 28 to 14. The remaining 14
are:
- 1 BigQuery;
- 2 connection session setup;
- 1 readiness probe;
- 3 stored procedure calls;
- 7 pinned legacy templates: reports ×3, order-transactions ×2, flash-sales ×1, finance feed ×1.

**Statements converted to builders:**
- dashboard: overview and daily counts;
- catalog-details: count, conflict probe, paged list, detail price aggregate, offline snapshot,
  matrix count, and audit count/page for 3 log kinds;
- hyperlocal-daily: count and page;
- scheduled reports: all 7 kinds;
- wallet history id: `LAST_INSERT_ID()` replaced by the insert's OK packet;
- scalar sub-SELECTs built with the builder: catalog counter barcode/price, inventory list
  barcode, customer voucher count.

**Fragments converted:** about 60 hand-written fragments became builder operators:
- `inArray`, including `inArray([])` for the old explicit `false` fallback;
- `eq` / `gt` / `gte` / `like` / `isNotNull`;
- `exists` / `notExists`;
- plain column references in place of columns wrapped in `sql`.

The typed `sql<T>` count rose from 104 to 147. The increase comes from new builder projections
that use typed CAST, ANY_VALUE and aggregate fields to keep the raw driver types; none of them
contains SELECT, FROM or JOIN text.

## 2. Exceptions
`orm-exceptions.md` lists them in full. In summary:
- **E1:** BigQuery client.
- **E2:** `pos_stock_syncer` / `pos_stock_syncer_bk` calls, with bound values.
- **E3:** verbatim pinned legacy report SQL with bound values:
  - daily report, `legacy-report-sql.ts`;
  - order report / order transactions, `order-report-sql.ts`;
  - flash sales, `flash-sales-sql.ts`, which needs `@rownum` session variables that Drizzle cannot
    express;
  - finance feed, `feed-sql.ts`;
  - the unexecuted scheduled-report oracle text.
- **E5:** connection session `SET` statements.
- **E6:** the `/ready` `SELECT 1` probe, in the shared `app.ts`.
- **E7:** `CURRENT_TIMESTAMP` column defaults.

## 3. Characterisation tests added
Each test seeds synthetic rows on loopback MySQL, runs the former SQL frozen verbatim in the
test, and requires output identical to the new code.

**`tests/catalog-details/orm-characterisation.mysql.test.ts`** (CAT), with
`tests/catalog-details/raw-oracle/*.ts` as frozen copies of the pre-conversion modules.
- Covers catalog search, detail, snapshot, matrix, the audit history for all 3 log kinds, and
  counter catalog.
- Cases include: sorts, pages, `%`/`_`/quote/injection-shaped searches, IDs above 2^53, NULL
  prices, multi-location pricelists, inactive and warehouse stores, missing users and storages,
  and three principals.
- Over 250 non-empty result sets are compared. Passed 7/7 against the old and the new src.

**`tests/operational-reports/hyperlocal-daily-orm.mysql.integration.test.ts`** (OPS).
- Covers 4 scopes × 2 periods × both directions × 4 pages.
- Cases include rounding, NULL statuses and a user ID above 2^53.
- Mutation check: flipping the sort fails the test.

**`tests/operational-reports/scheduled-data-orm.mysql.integration.test.ts`** (OPS).
- Covers all 7 kinds × 2 periods × `includeCompleted`.
- Cases include ROW_NUMBER first-log selection, a comment exactly at `end_timeslot`, excluded
  statuses and string ordering of IDs.
- Mutation checks: flag 18 → 7, `>` → `>=`, the status filter, ORDER BY, and ROW_NUMBER order
  each fail the test.

**`tests/administration/inventory-list-orm.mysql.test.ts`** (primary).
- Covers the inventory list against the former raw barcode sub-SELECT: 3 stores × 3 active
  filters × 6 searches × 4 cursor/limit pairs.
- Cases include no barcode, several barcodes, a `0` barcode and IDs above 2^53.
- Mutation check: changing the barcode order to `desc` fails the test.

**`tests/orm-render-equivalence.test.ts`** (primary, unit).
- Shows that the column unwraps, operator rewrites and payment-correction predicate render the
  former SQL with the same bound values.
- It is the evidence for the `administration/service.ts` join edits, because the suite that
  exercises them, `collections.mysql`, cannot run (see §5).

## 4. Optimisations, with proof
- **Wallet history id.** `checkout/benefit-adjustments/repository.ts` read the id with a second
  `SELECT CAST(LAST_INSERT_ID() AS CHAR)` round trip; it now takes the insert's OK-packet
  `insertId`. For a single-row auto-increment insert this is the same value, and `String()` of a
  mysql2 number or `bigNumberStrings` string is exact. Proof: `global-benefit-writer.mysql`
  (14 tests, including 20 concurrent adjustments) passes before and after.
- **Dashboard overview.** Now one aggregate over active stores with two scalar builder
  subqueries. It is still one statement returning one row. Proof: the dashboard MySQL suite
  (11/11) passes before and after, and it executes `currentDashboardQuery()` and its EXPLAIN.
- No N+1 removal or batching was done. No index or schema DDL was changed.

## 5. Test results
All runs used loopback MySQL 8.4.11 on 127.0.0.1:33911 with empty `sql_mode`, and every MySQL
test URL set (`MYSQL_INTEGRATION_URL` plus the module-specific variables).

**Static checks:**
- `npx tsc --noEmit -p .`: pass.
- `npx eslint .`: 1 error, `tools/administration/model-accounts/fixture.ts:2` unused
  `readFileSync`. It is identical at `43613a75`; the file is not W11's.
- `npx vitest run tests/orm-metadata.test.ts`: pass, 0 mismatches.

**Full backend `vitest`, with the fixture fix from §6 applied to both sides:**

| | passed | failed | skipped |
|---|---:|---:|---:|
| baseline worktree at `43613a75` | 1019 | 14 | 1 |
| `w11/orm-only` | 1047 | 10 | 1 |

- No test passes at baseline and fails on the branch.
- 24 tests are new.
- 4 `order-search/he-store-validation` cases failed in the baseline run and passed on the branch.
- The 10 failures on the branch all fail at baseline too:
  - `administration/collections.mysql` ×7: the fixture inserts duplicate `stores.store_name`,
    which the production unique key rejects;
  - `catalog-details/mysql.integration` "loads live variants…": golden capture missing;
  - `customer-history` Latin1 case;
  - `fulfillment/shipping-label-mysql`: golden capture missing.

**Module MySQL suites, before and after:** catalog-details 95/96 (the known golden miss),
operational-reports 94/94, dashboard 11/11, administration mysql.integration 43/43,
inventory-jobs 10/10, barcodes 15/15, terminal-directory 6/6, store-default-operators 7/7,
finance 10/10 and feed 1/1, fulfillment 10/10, legacy-fulfillment 8/8, order-history and
order-search (all pass), checkout suites (all pass), customer-profile 23/23, device-handoff 8/8,
stock-projection 12/12.

## 6. Shared-file edits and fixes outside ownership
- **`src/db/legacy-schema.ts`** (additions only, matching `production-schema.json`; orm-metadata
  still at 0 mismatches):
  - `FlagHistory` (`flag_history`);
  - `HyperlocalAvailabilityLog` (`hyperlocal_availability_log`);
  - `Comments.hl_status`.

  These let the scheduled report kinds use the builder.
- **`catalog-details/schema.ts`** (CAT): new read-only `catalogPriceList` projection that includes
  `location_id`, which the snapshot orders by. It follows that file's existing module-local
  pattern. Alternative: add `location_id` to the shared `PriceList`.
- **Test fixture fix** in `tests/administration/{inventory-jobs.mysql,mysql.integration}.test.ts`:
  removed `ALTER TABLE … ADD KEY` statements that the production snapshot already creates. They
  made both suites fail at setup (53 tests skipped) since the W9 merge.
- No edits to route/validation code, observability, demo branches, `app.ts`, `config.ts` or
  `package.json`.

## 7. Leftovers
1. **NEEDS USER DECISION:** accept E3 (about 85 KB of pinned legacy report SQL executed as
   verbatim text) as permanent exceptions, or commission a builder rewrite. Flash-sales cannot be
   expressed without its session variables either way.
2. `hyperlocal-daily.ts`: the MySQL branch is converted and characterised, but the service
   currently always routes to BigQuery, so the branch is unreachable.
3. `administration/collections.mysql.test.ts`: the fixture violates the production
   `store_name_unique` key and needs W8 to rework its tie data.
4. The detail-oracle and shipping-label golden captures need recapturing from the pinned source.
   This predates W11.
