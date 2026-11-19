# Live read-only production parity suite (Phase F1, W13)

Branch `w13/live-readonly` (from integration head `b6c4ddaf`). The suite runs the rewrite's real
MySQL read code against production through a guarded, read-only connection. It checks schema
drift and the shape of each read path. It never prints or stores a row value.

**What it does not prove:** it is not legacy feature parity. A passing path shows only that the
read code executes on production data, parses with its own contract schema, and holds its type,
scope and ordering invariants. It does not compare business values with the legacy app. Writes,
BigQuery, Redis-backed state and external services are outside its scope (see "Not covered").

## Files

| file | role |
|---|---|
| `tools/live-readonly/sql-guard.ts` | Pure statement guard (`guardStatement`): the allow-list, locking-read handling, multi-statement refusal. |
| `tools/live-readonly/connection.ts` | Env parsing, TLS/CA, the three guard layers, the plan gate, read-only session verification, guard statistics, `errorCode`. |
| `tools/live-readonly/schema.ts` | Drizzle table enumeration (the same method as `tests/orm-metadata.test.ts`) and the live-versus-snapshot comparison. |
| `tools/live-readonly/summary.ts` | Aggregate summary type, the PII-shape assertion, and the evidence writer (exclusive create). |
| `tools/live-readonly/seed-loopback.ts` | Loopback-only fixture: all 119 snapshot tables built from the snapshot DDL, plus synthetic rows. |
| `tests/live-readonly/sql-guard.test.ts` | Guard unit tests. These always run; they need no database. |
| `tests/live-readonly/live-readonly.test.ts` | The live suite. It skips entirely unless `POS_PROD_RO_MYSQL_URL` is set. |
| `package.json` | `npm run test:live-readonly` (`vitest run tests/live-readonly`). |

## Running against production (primary agent)

```sh
export PATH=/Users/rishabhbhatia/.npm/_npx/c9870267d9e0f935/node_modules/node/bin:$PATH
cd backend
POS_PROD_RO_MYSQL_URL='mysql://<ro-user>:<password>@<host>:3306/tss' \
  npm run test:live-readonly
```

| variable | default | meaning |
|---|---|---|
| `POS_PROD_RO_MYSQL_URL` | unset (suite skipped) | `mysql://` URL. The schema defaults to `tss`. Use a SELECT-only account where possible: that is a fourth layer of protection. |
| `POS_PROD_RO_MYSQL_CA` | `../global-bundle.pem` (the same default as `tools/schema/snapshot-production-schema.ts`) | CA bundle path for TLS with `rejectUnauthorized: true`. The value `plaintext-localhost` turns TLS off, and is accepted **only** for `127.0.0.1`/`localhost`/`::1`. For any other host it throws. |
| `POS_PROD_RO_MAX_EXECUTION_MS` | `10000` | `MAX_EXECUTION_TIME` per session, from 1000 to 10000. |
| `POS_PROD_RO_PLAN_ROW_LIMIT` | `100000` | Plan-gate threshold, at most 100000. |
| `POS_PROD_RO_LOCKING_READS` | `downgrade` | `refuse` is strict mode: every locking read is refused, and paths that need one are reported as skipped (see below). |
| `POS_PROD_RO_WRITE_EVIDENCE=1` | off | Writes `backend/evidence/live-readonly-<date>.json`. If that file exists, it writes `-2`, `-3` and so on, using exclusive create (`wx`). It never overwrites. |
| `POS_PROD_RO_EVIDENCE_DIR` | — | Writes the evidence file to this directory instead. Setting it also enables writing. |

Output: one JSON line on stdout. It holds `suite`, timestamps, the server version
(`x.y.z` only), settings, and `schema` (table count, matches, drift as table name, column name,
differing attribute names and column types). It also holds one entry per path (status,
reason/error code, row count, check names, statement/EXPLAIN/downgrade/refusal counts, plan
rejections as table, access type and estimate, and duration) and totals. `assertAggregateOnly`
rejects any string field outside `[A-Za-z0-9_ .:,()'<>/=+-]` or longer than 200 characters
before the summary is printed or written. No host, user, password, server error text or row value
appears. Errors are reported by code only, for example `ER_ACCESS_DENIED_ERROR`, `RO_PLAN_ROWS` or
`INVARIANT orders:id-desc`.

## Safety design

Every statement passes through three independent layers before it reaches production:

1. **Drizzle session.** The `logQuery` hook calls `guardStatement` before every builder call,
   `execute`, `all`, and transaction bracket, and throws before the driver is called.
2. **mysql2 promise pool and pool connections (Proxy).** Every `query`/`execute` is guarded
   again, and `prepare` is refused. Locking reads are downgraded here (see below). Every SELECT
   is `EXPLAIN`ed first: this is the plan gate.
3. **Every core mysql2 connection.** `query`, `execute` and `prepare` are wrapped on the instance
   with the **strict** guard, which refuses locking reads too. A new connection first sends exactly
   `SET SESSION TRANSACTION READ ONLY` and `SET SESSION MAX_EXECUTION_TIME=<n>`, then verifies
   both with `SELECT @@SESSION.transaction_read_only, @@SESSION.max_execution_time`. If any of
   these fails, the connection is destroyed and refused before the caller's queued statement runs.
   The suite also asserts the session state at start, and that every opened connection verified.

`multipleStatements: false`. The driver options match `src/db/pools.ts` (`supportBigNumbers`,
`bigNumberStrings`, `dateStrings`, `timezone: 'Z'`), so the read paths see production value types.
The pool holds at most 2 connections.

### Allowed statements
- SELECT, `WITH … SELECT`, parenthesised SELECT (`(…) UNION ALL (…)`), SHOW (columns, create
  table/view, tables, status, variables, warnings, …), DESCRIBE/DESC, and EXPLAIN [FORMAT=…]
  of a read.
- Exactly `SET SESSION TRANSACTION READ ONLY` and `SET SESSION MAX_EXECUTION_TIME=1..10000`.
- The transaction brackets Drizzle emits around the rewrite's read code: `begin`,
  `start transaction [with consistent snapshot] [read only]`, `commit`, `rollback`, and
  `set transaction isolation level <level>`. That last one is a next-transaction
  characteristic, not a session SET; the online-detail, customer, finance and daily-report reads
  issue it. None of these can change data, and the session is already READ ONLY.
  `start transaction read write` is refused.

### Refused statements
The guard refuses before sending:
- INSERT/REPLACE (outside the string functions `INSERT(`/`REPLACE(`), UPDATE, DELETE, and any
  DDL;
- CALL, LOAD, HANDLER, LOCK/UNLOCK, DO, SAVEPOINT/RELEASE, PREPARE, GRANT and similar;
- every other SET;
- `SELECT … INTO` (variables, OUTFILE, DUMPFILE);
- `LOAD_FILE`, `GET_LOCK`, `SLEEP`, `BENCHMARK`;
- `EXPLAIN ANALYZE`, because it executes the statement;
- MySQL executable comments `/*! … */`;
- unterminated quotes or comments;
- any `;`, that is, any multi-statement text.

String literals, quoted identifiers and comments are tokenised and treated as opaque, so a
literal such as `'DELETE; …'` is not mistaken for a statement. The unit tests also run every E3
legacy report SQL text through the guard, rendered with bound values, to show it is accepted.
That covers the daily `excludedProducts`/`storeOrders`/`onlineOrders`, the order-report
sales/returns/count SQL for both sources and both date types, both flash-sales kinds, both feed
forms, and all 7 scheduled source queries.

### Locking reads: the decision to record

> **Update (W16, `parity/w16-report.md`).** The order list/detail/search, online-detail and
> catalog-barcode authorizations no longer take row locks: they read the writer with plain
> consistent reads in a read-only transaction. On loopback every path now passes with
> `POS_PROD_RO_LOCKING_READS=refuse` and 0 downgraded locks. The text below describes the
> state measured before that change.
The rewrite's read paths confirm authorization on the writer with locking reads.
`assertCurrentStoreAccess` defaults to `FOR UPDATE` on `stores`. Order list, detail and search,
and online detail, use `FOR SHARE` on `pos_user`, `stores`, `orders` and `order_stores`. Measured
on MySQL 8.4 with the session set READ ONLY:
- `SELECT … FOR UPDATE` fails with `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`;
- `SELECT … FOR SHARE` succeeds and **takes shared row locks**.

Default `downgrade` mode removes exactly one trailing locking clause at statement depth (`FOR
UPDATE|SHARE [NOWAIT|SKIP LOCKED]`, `LOCK IN SHARE MODE`). The statement is then sent as a plain
consistent read. A locking clause anywhere else is refused, for example in a subquery or before a
UNION. The core-connection layer always refuses locking reads. So nothing that takes a row lock,
and no FOR UPDATE, is ever sent. Each path reports `downgradedLocks` and `downgradedUpdateLocks`.

With `POS_PROD_RO_LOCKING_READS=refuse`, every locking read is refused. Paths whose only refusals
are locking reads are then reported as `skip: RO_GUARD_LOCKING_READ` (on the loopback run: the
three order paths). Any other refusal fails the path.

### Bounds and the plan gate
- **Queries the suite writes itself.** These are the sampling queries, all Drizzle builder:
  `LIMIT` ≤ 10, with a PK or indexed predicate.
  - `pos_user` active super-admin `ORDER BY id LIMIT 1`.
  - Latest 5 `orders` by PK, and latest 5 `order_stores` by PK.
  - The sampled order by PK.
  - An online order within the PK range `[latest−5000, latest]`.
  - `has_products` by `order_id` (indexed).
  - `store_counters` by `store_id` (indexed).
  - `stores` by PK.
- **Statements issued by modules** keep their own bounds. For example, scheduled and flash-sales
  reads use `LIMIT 70001`, and the online-detail mappings use `LIMIT 10001`. The suite narrows
  their inputs instead: one store, one business day (or today for the data-reader reports), one
  hour for the scheduled reports, page sizes ≤ 25, and explicit order IDs.
- **Plan gate.** Every SELECT is `EXPLAIN`ed with the same bound values before it is sent. It is
  skipped, and the path reported as `skip: RO_PLAN_FULL_SCAN` or `skip: RO_PLAN_ROWS` with table,
  access type and estimate, when:
  - any plan row is `type=ALL` on a table with more than `POS_PROD_RO_PLAN_ROW_LIMIT` rows. The
    row count comes from `information_schema.TABLES.table_rows`, or from the EXPLAIN estimate
    for aliases and derived tables;
  - any plan row estimates more than that limit.

  This also applies when a module swallows the error: the harness reads the gate's own counters.
  The schema check's `INFORMATION_SCHEMA` metadata reads touch no data table and are exempt from
  EXPLAIN.

### Writes
None of the covered paths writes. `financeService.state` can `UPDATE store_day_close` when a close
is `CLOSED`, so the suite calls its read part instead: the exported `collectionSnapshot`, in a
read-only transaction. Login (which writes `last_login`), check-in writes, audit writes and every
mutation route are not called. Any accidental write fails the path loudly with a `RO_GUARD_*`
code. That includes a write a module catches and swallows, because the refusal counter is checked
after each path.

## Paths covered

| path | real code exercised | checks |
|---|---|---|
| `sampling` | Drizzle builder queries above | bounded IDs only, kept in memory |
| `schema` | every Drizzle-mapped production table (99) | `INFORMATION_SCHEMA.COLUMNS` (all 9 snapshot attributes) and `SHOW CREATE TABLE` (without `AUTO_INCREMENT=`) equal `tests/golden/schema/production-schema.json`; drift listed per table and column |
| `operators-stores-counters` | `activeAccountReader`, `storeDirectory.eligible/name`, `catalogService.stores/counters` | `pos_user` value types, `StoreDto`/`CounterDto`, counter id ascending, store scope |
| `catalog-product-barcode` | `catalogService.products` (price list id 2, stock, hold, storage), keyset next page, exact-GTIN lookup + `uniqueBarcodeProduct`, `readCatalogStockLocations` | `CatalogProductDto`, id ascending, cursor advances, in-stock only, barcode resolves to the same product, request order kept |
| `checkout-quote-inputs` | `checkoutRepository.cartProduct/counter/customer`, counter product page including out-of-stock | cart product and `CustomerIdentity` types, active counter, price and stock types |
| `inventory-list` | `inventoryService.list` | row types (bigint IDs, boolean flags), id ascending, cursor |
| `customer-by-id` | `readCurrentOrderCustomer` | `currentOrderCustomer` zod contract, id binding |
| `orders-store-list-detail` | `ordersService.list` (with `orderReadAuthority`) and `.detail` (`storeOrderDetailReader`) | `OrderDto`, `StoreOrderDetail` shape, id descending, store scope, business-day window, line order |
| `orders-search-store` | `orderSearchService.search` (ST tab for one day, explicit order ID) and `.options` | `sourceRowSchema`, `recordsTotal` covers the page, id descending, explicit ID found |
| `orders-online-search-detail` | `orderSearchService.search` (N, explicit ID), `onlineOrderDetailService.read` | `sourceRowSchema`, `onlineOrderDetail` zod contract, customer binding |
| `reports-daily-today` | `reportService.daily` for today (data reader, legacy E3 daily SQL, payment-correction cash, banking) | reader `data`, `rollupSchema`, scalar totals, business day |
| `reports-legacy-daily-sql` | E3 `excludedProducts` + `bindReportSql(storeOrders/onlineOrders)` for the sampled store and day, in a read-only repeatable-read transaction | `rollupSchema`, store scope, business day |
| `reports-scheduled-hour` | `scheduledMysqlRows` against the frozen E3 `scheduledSourceQuery` for all 7 kinds over one hour | row-count parity and exact value/type parity between ORM rows and source-SQL rows |
| `reports-order-transactions-today` | `orderTransactionsReportService.read`, store and online, today (E3 order-report SQL on the data reader) | reader `data`, `orderReportLineSchema` (inside the service), totals |
| `reports-flash-sales-today` | `flashSalesReportService.read`, today (E3 flash-sales SQL on the data reader) | reader `data`, `flashSalesSourceRowSchema` (inside the service) |
| `finance-cash` | `collectionSnapshot`, `cashLedgerService.stores/read` (today), `financeFeedService.orders` (today, by store code; E3 feed SQL) | money-string types, ledger stores contract, data-reader routing or warehouse-needed, feed contract |

**Fakes.** Fakes replace only the services that cannot be used read-only:
- Redis: an in-process `memoryRedisPort` bound as the check-in store, seeded with the sampled
  operator's check-in through `loginCheckIns`;
- checkout session state: `memoryStateStore`;
- BigQuery: `queryReport` returns no rows, `dailyRollups` reports `WAREHOUSE_ONLY`, `auxiliary`
  returns empty maps. The fake BigQuery view names exist only to get past options validation.

The principal is a real active super-admin `pos_user` (role 1, user type 1), so the authority
reads match its row. All MySQL reads are real.

## Not covered (the parity scope is exact)
- Every write and mutation path. Checkout quotes priced by the API-v2 cart, payments, OTP and SMS.
- BigQuery-routed reads: past-day daily reports, historical cash ledger, return-date transactions,
  feed returns, flash-sales refunds. Warehouse values are not checked.
- Redis-backed state: sessions, OTP, idempotency, claims.
- HTTP route layers (validation, session revalidation, audit events). Modules are called directly.
- `financeService.state` itself, because it may write; only its read part runs.
- Value-level equality with the legacy Django app.

## Loopback verification (done on this branch, no production access)

```sh
D=$PWD/.tmp/mysql-w13
/opt/homebrew/opt/mysql@8.4/bin/mysqld --initialize-insecure --datadir=$D/data
/opt/homebrew/opt/mysql@8.4/bin/mysqld --datadir=$D/data --port=3418 --bind-address=127.0.0.1 \
  --socket=/private/tmp/claude-501/w13ro.sock --mysqlx=OFF --sql-mode='' --pid-file=$D/mysqld.pid &
cd backend
node --import tsx tools/live-readonly/seed-loopback.ts mysql://root@127.0.0.1:3418/pos_live_readonly_fixture
POS_PROD_RO_MYSQL_URL=mysql://root@127.0.0.1:3418/pos_live_readonly_fixture \
POS_PROD_RO_MYSQL_CA=plaintext-localhost npm run test:live-readonly
/opt/homebrew/opt/mysql@8.4/bin/mysqladmin -h127.0.0.1 -P3418 -uroot shutdown
```

Results, MySQL 8.4.11, 19 November 2026:
- **Default run.** 82/82 tests pass: 65 guard unit tests and 17 live tests. All 16 summary paths
  pass. Totals: 335 statements, 178 EXPLAINs, 56 locking reads downgraded (12 of them FOR
  UPDATE), 0 refusals, 0 plan rejections.
- **Schema.** 99/99 Drizzle-mapped tables match. The loopback server is 8.4 and the snapshot is
  8.0.39, so the DDL comparison ran in `cross-version` mode. In that mode only the
  column-level `CHARACTER SET`/`COLLATE` clause text is ignored, because 8.4 prints
  `CHARACTER SET x COLLATE y` where 8.0 prints one of them. Column charset and collation are
  still compared exactly through `INFORMATION_SCHEMA.COLUMNS`. Against production 8.0.39 the
  comparison is `exact`. With an exact comparison, 8 tables differed on 8.4 for this reason
  alone: `attributes`, `categories`, `deliverable_pincodes`, `has_addresses`, `order_status`,
  `pos_user`, `product_types` and `products`.
- **Writes.** The checksums of `orders`, `order_stores`, `has_products`, `pos_user`, `stores`,
  `store_counters`, `product_store`, `users` and `store_day_close` were unchanged across a run.
  `Com_insert` and `Com_update` were unchanged. `Com_delete` rose by exactly 1. That is the
  loopback-only backstop test, which deliberately sends a DELETE on a raw, unguarded
  READ ONLY session to prove the server rejects it with
  `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`. Every guarded refusal is client-side and sends
  nothing.
- **Plan gate.**
  - `POS_PROD_RO_PLAN_ROW_LIMIT=1`: sampling is reported as `skip: RO_PLAN_ROWS` (`orders`
    index scan), and every other path as `skip: NO_SAMPLE_ROWS`.
  - `=2`: `reports-flash-sales-today` is reported as `skip: RO_PLAN_FULL_SCAN` (`<derived2>`
    ALL). The service swallowed the error into `REPORT_QUERY_FAILED`, and the gate counters
    still classified the skip.
- **Strict mode.** With `POS_PROD_RO_LOCKING_READS=refuse`, the three order paths are reported as
  `skip: RO_GUARD_LOCKING_READ`, and the other 13 pass.
- **Evidence file.** Two runs with `POS_PROD_RO_EVIDENCE_DIR` wrote
  `live-readonly-2026-11-19.json` and then `live-readonly-2026-11-19-2.json`. No evidence file
  is committed.
- **No URL set.** With `POS_PROD_RO_MYSQL_URL` unset, the live file skips all 17 tests and the 65
  guard tests run.

**Production-shaped volume (W16).** `tests/live-readonly/volume-fixture.ts` adds ~360k synthetic
`products` and ~22k `product_store` rows per store to the seeded schema (run it after
`seed-loopback.ts`, same URL). With it, the plan gate reproduces the production rejection
(`products` range, estimate ~176k) on the pre-W16 catalog query.

The synthetic data is small, so several report paths return 0 rows on loopback. Loopback proves
execution, guard behaviour and contract parsing, not value coverage.

## NEEDS USER DECISION
- **Locking-read downgrade.** Do we accept `downgrade` as the default for the production run? The
  alternative is `refuse`, which leaves the order list/detail/search and online-detail paths
  unverified, because their authorization confirmation uses `FOR UPDATE`/`FOR SHARE`. Either way,
  no locking statement reaches production.
