# MySQL ORM exceptions (W11, Phase E1)

Branch `w11/orm-only` (from integration head `43613a75`). Every MySQL statement in `backend/src`
runs through the Drizzle query builder (`select`/`insert`/`update`/`delete`, joins, subqueries,
`exists`, `onDuplicateKeyUpdate`, transactions, `.for(...)`), **except the sites below**. Each one is
listed with `file:line` (paths relative to `backend/src`) and the reason.

Final sweep commands (run in `backend/`):

```
grep -rnE 'sql`|\.execute\(|\.query\(' src   # task grep: 96 sites (213 at 43613a75)
grep -rnE 'sql<' src                        # typed sql<T> expressions: 150 sites (104 at 43613a75)
```

Every site from both commands appears in the generated tables at the end of this file. Sites
fall into two groups:

- **E1–E7, exceptions.** Statements that do not go through the builder, or SQL that is not a
  query. All request values are bound parameters; `sql.raw` only receives shipped constants.
- **T, typed expressions inside a builder call.** Allowed by the W11 rules. They cover what has
  no Drizzle builder: CAST, CASE, COALESCE/CONCAT/TRIM/NULLIF/IF, GROUP_CONCAT, ANY_VALUE and
  aggregates that must keep the raw driver type, window functions, literals, scalar-subquery
  wrappers around a builder query, `LIKE … ESCAPE`, the pre-existing `JOIN_ORDER` hint, and
  values written to a column whose ORM type cannot carry them. No T site holds a hand-written
  SELECT, FROM or JOIN. A multi-line scan of every `sql` template confirmed this after commit
  `f108ead2`.

## E1. BigQuery / warehouse
| site | reason |
|---|---|
| `modules/warehouse.ts:32` | BigQuery client `query({ query, params, types })`. Warehouse SQL is not MySQL. Values are named BigQuery parameters only. The other warehouse builders (`*/warehouse*.ts`, `order-history/sql.ts`, `finance/history.ts`, `special-permission-history/warehouse-sql.ts`, the BigQuery branches of `scheduled-data.ts`, `order-transactions.ts`, `hyperlocal-daily.ts` and `feedback-history-sql.ts`) are plain strings run through this single site. |

## E2. Stored procedure calls (bound values)
| site | reason |
|---|---|
| `modules/administration/stock-procedure.ts:24-25` | `call pos_stock_syncer(...)` on the writer transaction. Drizzle has no builder for `CALL`. Each argument is a bound value. |
| `modules/checkout/return-workflow/repository.ts:365-366` | `call pos_stock_syncer(...)` inside the return transaction, the same procedure as legacy. Bound values. |
| `modules/administration/ecommerce-sync/job.ts:24-25` | `call pos_stock_syncer_bk(...)` from the ecommerce sync job. Bound values. |

## E3. Pinned legacy source SQL (verbatim copies, bound values)
These statements execute SQL text copied verbatim from the pinned legacy source. Each file
carries the SHA-256 of its legacy source. Parity rests on that text: the suites run the text, or
strict-mode projections derived from it, against isolated MySQL and source oracles. In most cases
the BigQuery path uses the same text. W11 left this text unchanged on purpose.

| site | source text | why it is not converted |
|---|---|---|
| `modules/reports.ts:116-128` (`bindReportSql`), `:254`, `:281`, `:291` | `legacy-report-sql.ts` (`report/report_queries.py`, SHA-256 `6ef32f5c…`, about 13 KB). Daily report MySQL path: `excludedProducts`, `storeOrders`, `onlineOrders`. | Three-level nested derived tables (`FROM (SELECT … FROM (SELECT …) t GROUP BY t.id) ord`), `BETWEEN`, `FIELD()`, and `CASE`/`ROUND` money arithmetic in every projection. A builder version would be about 95% `sql` fragments and would drop the textual link to the hash that `tests/reports/warehouse-publication.test.ts` pins (`source_sql_sha256`). `daily-report-corrections.ts` patches the template text (`paymentCorrectionDailyStoreTemplate`). Its order predicate is now built with `inArray`. |
| `modules/operational-reports/order-transactions.ts:148-149`, `:168-169`; `order-report-query.ts:119-122` | `order-report-sql.ts` (SHA-256 `6ef32f5c…`, about 39 KB). | A parser (`orderReportProjection`/`strictOrderReportSelect`) rewrites the legacy SELECT lists into `ANY_VALUE` strict form, then runs `(sales) UNION ALL (returns) ORDER BY … LIMIT/OFFSET`. Drizzle's `unionAll` only combines builder selects, so it cannot wrap parser-derived text. `tests/operational-reports/order-report-query.test.ts` asserts the parsed projection, and `order-report-mysql.integration.test.ts` runs `combinedOrderQueries` against the source oracle. |
| `modules/operational-reports/flash-sales.ts:251-252`; `flash-sales-query.ts:66-76` | `flash-sales-sql.ts` (SHA-256 `3123e877…`, about 13 KB). | The source uses MySQL session user variables (`@rownum := @rownum + 1`, `CROSS JOIN (SELECT @rownum := 0)`). Drizzle cannot express them. Anchored regexes derive a CTE form from the inspected text, and the same text drives `flashSalesWarehouseQuery`. |
| `modules/finance/feed.ts:122`; `feed-query.ts:52-56` (`bindFeedSql`) | `feed-sql.ts` (Glassbox source SHA-256 `d9899801…`, about 20 KB). | Legacy `%s` templates, made strict by `strictFeedProjection`. `tests/finance/feed-mysql.integration.test.ts` runs `feedQueries` against the source oracle. |
| `modules/operational-reports/scheduled-data.ts:142`, `:145` (`scheduledSourceQuery`) | Static source-compatible SQL. | **No `src` path executes it any more.** All 7 scheduled kinds read through the builder (`scheduledMysqlRows`). It remains exported only as the frozen oracle for `tests/operational-reports/scheduled-data.mysql.integration.test.ts` and `scheduled-data-orm.mysql.integration.test.ts`. |

**NEEDS USER DECISION:** accept E3 as permanent exceptions, or commission a builder rewrite of
about 85 KB of legacy report SQL. A rewrite needs new characterisation suites per report, and
flash-sales still cannot drop its session variables.

## E5. Connection session setup (not data queries)
| site | reason |
|---|---|
| `db/pools.ts:46` | `SET SESSION TRANSACTION READ ONLY` on each new reader connection. This runs on the raw mysql2 connection before Drizzle sees it. |
| `db/pools.ts:49` | `SET SESSION MAX_EXECUTION_TIME=…`. Same place; the value is a code constant. |

## E6. Readiness probe
| site | reason |
|---|---|
| `app.ts:414` | `SELECT 1` per reader for `/ready`. A connectivity probe that reads no table, and Drizzle's select builder requires `FROM`. `app.ts` is a shared file, so W11 kept the edit out. |

## E7. Column defaults in a table definition (not queries)
| site | reason |
|---|---|
| `modules/application-links/schema.ts:10`, `:13`, `:16` | `.default(sql\`CURRENT_TIMESTAMP\`)` on the production `pos_to_app_logs` definition. This is DDL metadata for inserts. No statement text is involved. |

## Notable typed expressions (T) that bind values rather than columns
- `modules/administration/import-job.ts:238, 390, 431, 440, 454, 472, 482`: `stock`/`is_avail`/`is_del`
  are written as `sql\`${bigint}\``. Legacy writes arbitrary Python ints, for example
  `is_avail = 5` into `tinyint`, and stock deltas beyond `int`. The ORM types (`int` → number,
  `tinyintBoolean` → boolean) cannot carry these values, and the empty `sql_mode` clamps or
  stores them exactly as legacy did. These are bound parameters inside builder `update`/`insert`
  calls.
- `modules/order-history/search/native.ts:71, 76, 136, 141`: a bound boolean scope flag
  (`sql\`${storeMode}\``) in the join condition.
- `modules/checkout/benefit-adjustments/repository.ts:364, 369`: a batched `CASE id WHEN … THEN …`
  value in a builder `update().set()`.
- `modules/operational-reports/inventory.ts`: `onDuplicateKeyUpdate({ set: { product: sql\`${ProductStore.product}\` } })`.
  This is a self-reference no-op. Drizzle turns a Column in `set` into a bound value, so the
  column reference has to be an SQL expression.


## Generated: every task-grep site (`sql\` | .execute( | .query(`)

| site | category | code (backticks shown as ˋ) |
|---|---|---|
| `app.ts:414` | E6 readiness probe | db.get(reader).execute(sqlˋSELECT 1ˋ), |
| `db/pools.ts:46` | E5 connection session setup | connection.query('SET SESSION TRANSACTION READ ONLY', (error) => { |
| `db/pools.ts:49` | E5 connection session setup | connection.query(ˋSET SESSION MAX_EXECUTION_TIME=${readOnly ? 10000 : 15000}ˋ, (error) => { |
| `modules/application-links/schema.ts:10` | E7 column DEFAULT in a table definition (not a query) | .default(sqlˋCURRENT_TIMESTAMPˋ), |
| `modules/application-links/schema.ts:13` | E7 column DEFAULT in a table definition (not a query) | .default(sqlˋCURRENT_TIMESTAMPˋ), |
| `modules/application-links/schema.ts:16` | E7 column DEFAULT in a table definition (not a query) | .default(sqlˋCURRENT_TIMESTAMPˋ), |
| `modules/customer-history/gateway.ts:58` | T CASE expression | sqlˋCASE WHEN ${HasProduct.sub_prod_id}>0 THEN ${HasProduct.sub_prod_id} ELSE ${HasProduct.product} ENDˋ (join key, legacy `users/views.py:883`) |
| `modules/customer-history/gateway.ts:65` | T CASE expression | sqlˋCASE WHEN ${effective.parent_prod_id}>0 THEN ${effective.parent_prod_id} ELSE ${effective.id} ENDˋ (join key, legacy `users/views.py:884`) |
| `modules/customer-history/gateway.ts:86` | T SQL function expression | gt(Order.created_at, sqlˋNOW() - INTERVAL 30 DAYˋ) (legacy `users/views.py:913`) |
| `modules/customer-history/gateway.ts:115` | T SQL function expression | .orderBy(desc(sqlˋDATE(${Order.created_at})ˋ), desc(Order.id)) |
| `modules/catalog-details/snapshot.ts:28` | T CAST expression | .select({ gtin: sqlˋcast(${ProductBarcode.gtin} as char)ˋ }) |
| `modules/catalog-details/snapshot.ts:44` | T CASE expression | sqlˋcase when ${own} then ${Product.id} else ${Product.parent_prod_id} endˋ, |
| `modules/catalog-details/queries.ts:72` | T CAST expression | like(sqlˋcast(${Product.id} as char)ˋ, pattern), |
| `modules/catalog-details/queries.ts:108` | T aggregate / ANY_VALUE expression | .select({ categories: sqlˋgroup_concat(distinct ${catalogCategories.category})ˋ }) |
| `modules/catalog-details/queries.ts:113` | T aggregate / ANY_VALUE expression | .select({ storeNames: sqlˋgroup_concat(distinct ${Store.store_name})ˋ }) |
| `modules/catalog-details/matrix.ts:161` | T CAST expression | ? or(like(Product.product, pattern), like(sqlˋcast(${Product.id} as char)ˋ, pattern)) |
| `modules/gift-card-batches/service.ts:315` | T CAST expression | ? like(sqlˋCAST(${GiftCardCollection.id} AS CHAR)ˋ, pattern) |
| `modules/reports.ts:116` | E3 pinned legacy source SQL (bound values) | storeIds.map((id) => sqlˋ${BigInt(id)}ˋ), |
| `modules/reports.ts:117` | E3 pinned legacy source SQL (bound values) | sqlˋ, ˋ, |
| `modules/reports.ts:121` | E3 pinned legacy source SQL (bound values) | (exclusions.length ? exclusions : [0n]).map((id) => sqlˋ${id}ˋ), |
| `modules/reports.ts:122` | E3 pinned legacy source SQL (bound values) | sqlˋ, ˋ, |
| `modules/reports.ts:124` | E3 pinned legacy source SQL (bound values) | if (part === '%s') return sqlˋ${dates[dateIndex++]}ˋ; |
| `modules/reports.ts:128` | E3 pinned legacy source SQL (bound values) | return sql.join(parts, sqlˋˋ); |
| `modules/reports.ts:254` | E3 pinned legacy source SQL (bound values) | const [excluded] = await transaction.execute(sql.raw(legacyReportSql.excludedProducts)); |
| `modules/reports.ts:281` | E3 pinned legacy source SQL (bound values) | transaction.execute( |
| `modules/reports.ts:291` | E3 pinned legacy source SQL (bound values) | transaction.execute( |
| `modules/administration-history/service.ts:172` | T SQL function expression | eq(actorForeignKey.tableSchema, sqlˋDATABASE()ˋ), |
| `modules/checkout/return-workflow/repository.ts:365` | E2 stored procedure call (bound values) | await tx.execute( |
| `modules/checkout/return-workflow/repository.ts:366` | E2 stored procedure call (bound values) | sqlˋcall pos_stock_syncer(${storeId},${productId},${after},${0},${BigInt(user.id)},${message})ˋ, |
| `modules/checkout/benefit-adjustments/repository.ts:364` | T CASE expression | cases = batch.map((row) => sqlˋWHEN ${BigInt(row.historyId)} THEN ${row.usedAmount}ˋ); |
| `modules/checkout/benefit-adjustments/repository.ts:369` | T CASE expression | usedAmount: sqlˋCASE ${table.id} ${sql.join(cases, sqlˋ ˋ)} ELSE ${table.usedAmount} ENDˋ, |
| `modules/dashboard/queries.ts:20` | T scalar subquery built with the builder | active_operators: sqlˋ${builder |
| `modules/dashboard/queries.ts:26` | T scalar subquery built with the builder | parent_products: sqlˋ${builder |
| `modules/dashboard/queries.ts:34` | T literal | .select({ one: sqlˋ1ˋ }) |
| `modules/operational-reports/inventory.ts:66` | T column self-reference in upsert set | .onDuplicateKeyUpdate({ set: { product: sqlˋ${ProductStore.product}ˋ } }); |
| `modules/operational-reports/performance.ts:147` | T CASE expression | sqlˋcase when ${HasProduct.salesperson_id}=0 then ${OrderStore.salespersonId} else ${HasProduct.salesperson_id |
| `modules/operational-reports/performance.ts:154` | T IS NOT NULL value expression | sqlˋnullif(${SalesPerson.employee_id},'') is not nullˋ, |
| `modules/operational-reports/performance.ts:206` | T IS NOT NULL value expression | sqlˋnullif(${OrderStore.performanceJson},'') is not nullˋ, |
| `modules/operational-reports/scheduled-data.ts:142` | E3 pinned legacy source SQL (bound values) | ? sqlˋ${params[part.slice(2, -2) as keyof typeof params]}ˋ |
| `modules/operational-reports/scheduled-data.ts:145` | E3 pinned legacy source SQL (bound values) | sqlˋˋ, |
| `modules/operational-reports/export-service.ts:451` | T CAST expression | like(sqlˋcast(${ReportExport.created_at} as char)ˋ, pattern), |
| `modules/operational-reports/flash-sales-query.ts:66` | E3 pinned legacy source SQL (bound values) | ? sqlˋ${from}ˋ |
| `modules/operational-reports/flash-sales-query.ts:68` | E3 pinned legacy source SQL (bound values) | ? sqlˋ${to}ˋ |
| `modules/operational-reports/flash-sales-query.ts:71` | E3 pinned legacy source SQL (bound values) | storeIds.map((id) => sqlˋ${id}ˋ), |
| `modules/operational-reports/flash-sales-query.ts:72` | E3 pinned legacy source SQL (bound values) | sqlˋ,ˋ, |
| `modules/operational-reports/flash-sales-query.ts:76` | E3 pinned legacy source SQL (bound values) | sqlˋˋ, |
| `modules/operational-reports/flash-sales.ts:251` | E3 pinned legacy source SQL (bound values) | result = await reader.execute( |
| `modules/operational-reports/flash-sales.ts:252` | E3 pinned legacy source SQL (bound values) | sqlˋ${flashSalesMysqlQuery(kind, bounds.from, bounds.to, stores)} LIMIT 70001ˋ, |
| `modules/operational-reports/order-report-query.ts:119` | E3 pinned legacy source SQL (bound values) | sqlˋ${sql.raw(count ? 'SELECT COUNT(DISTINCT hp.id) AS count\n' + orderReportProjection(query).from.replace(or |
| `modules/operational-reports/order-report-query.ts:120` | E3 pinned legacy source SQL (bound values) | storeIds.map((id) => sqlˋ${id}ˋ), |
| `modules/operational-reports/order-report-query.ts:121` | E3 pinned legacy source SQL (bound values) | sqlˋ,ˋ, |
| `modules/operational-reports/order-report-query.ts:122` | E3 pinned legacy source SQL (bound values) | )}) ${count ? sqlˋˋ : sqlˋGROUP BY arl.order_id,arl.prod_id,hp.idˋ}ˋ; |
| `modules/operational-reports/order-transactions.ts:148` | E3 pinned legacy source SQL (bound values) | counted = await reader.execute( |
| `modules/operational-reports/order-transactions.ts:149` | E3 pinned legacy source SQL (bound values) | sqlˋSELECT (${query.salesCount})+(${query.returnsCount}) AS countˋ, |
| `modules/operational-reports/order-transactions.ts:168` | E3 pinned legacy source SQL (bound values) | const result = await reader.execute( |
| `modules/operational-reports/order-transactions.ts:169` | E3 pinned legacy source SQL (bound values) | sqlˋ(${query.sales}) UNION ALL (${query.returns}) ORDER BY transaction_date DESC,id DESC LIMIT ${limit} OFFSET |
| `modules/operational-reports/returned-orders.ts:204` | T CAST expression | like(sqlˋcast(${ReturnOrder.order_id} as char)ˋ, search), |
| `modules/operational-reports/returned-orders.ts:205` | T CAST expression | like(sqlˋcast(${ReturnOrder.prod_id} as char)ˋ, search), |
| `modules/operational-reports/returned-orders.ts:206` | T CAST expression | like(sqlˋcast(${ReturnOrder.qty} as char)ˋ, search), |
| `modules/operational-reports/returned-orders.ts:210` | T CAST expression | like(sqlˋcast(${ReturnOrder.created_at} as char)ˋ, search), |
| `modules/finance/feed-query.ts:54` | E3 pinned legacy source SQL (bound values) | index < args.length ? [sql.raw(part), sqlˋ${args[index]}ˋ] : [sql.raw(part)], |
| `modules/finance/feed-query.ts:56` | E3 pinned legacy source SQL (bound values) | sqlˋˋ, |
| `modules/finance/feed.ts:122` | E3 pinned legacy source SQL (bound values) | database.execute(queries.sales), |
| `modules/administration/ecommerce-sync/job.ts:24` | E2 stored procedure call (bound values) | .execute( |
| `modules/administration/ecommerce-sync/job.ts:25` | E2 stored procedure call (bound values) | sqlˋcall pos_stock_syncer_bk(${storeId}, ${productId}, ${String(stock)}, 0, 0, ${'Updated by System'})ˋ, |
| `modules/administration/stock-procedure.ts:24` | E2 stored procedure call (bound values) | await transaction.execute( |
| `modules/administration/stock-procedure.ts:25` | E2 stored procedure call (bound values) | sqlˋcall pos_stock_syncer(${BigInt(value.storeId)},${BigInt(value.productId)},${value.stock},${0},${BigInt(val |
| `modules/administration/terminal-directory.ts:98` | T literal | provider: text(sqlˋ'pine-labs'ˋ, 'provider'), |
| `modules/administration/terminal-directory.ts:104` | T literal | deviceSerialNumber: text(sqlˋ'-'ˋ, 'device_serial_number'), |
| `modules/administration/terminal-directory.ts:108` | T SQL function expression | storeName: text(sqlˋCOALESCE(${Store.store_name}, '')ˋ, 'current_store_name'), |
| `modules/administration/terminal-directory.ts:117` | T literal | input.provider === 'paytm' ? sqlˋFALSEˋ : undefined, |
| `modules/administration/terminal-directory.ts:123` | T literal | provider: text(sqlˋ'paytm'ˋ, 'provider'), |
| `modules/administration/terminal-directory.ts:128` | T literal | imei: text(sqlˋ'-'ˋ, 'imei_no'), |
| `modules/administration/terminal-directory.ts:130` | T CAST expression | sqlˋCAST(${PosPaytmMachine.device_serial_no} AS CHAR)ˋ, |
| `modules/administration/terminal-directory.ts:136` | T literal | storeCode: text(sqlˋ'-'ˋ, 'merchant_store_pos_code'), |
| `modules/administration/terminal-directory.ts:137` | T SQL function expression | storeName: text(sqlˋCOALESCE(${Store.store_name}, '')ˋ, 'current_store_name'), |
| `modules/administration/terminal-directory.ts:146` | T literal | input.provider === 'pine-labs' ? sqlˋFALSEˋ : undefined, |
| `modules/administration/service.ts:1160` | T SQL function expression | column: sqlˋtrim(concat(coalesce(${SalesPerson.first_name},''),' ',coalesce(${SalesPerson.last_name},'')))ˋ, |
| `modules/administration/service.ts:1478` | T SQL function expression | column: sqlˋtrim(concat(coalesce(${PosUser.first_name},''),' ',coalesce(${PosUser.last_name},'')))ˋ, |
| `modules/administration/import-job.ts:238` | T value bound for a column whose ORM type cannot carry it | .set({ stock: sqlˋ${updated}ˋ }) |
| `modules/administration/import-job.ts:390` | T value bound for a column whose ORM type cannot carry it | .set({ stock: sqlˋ${after}ˋ }) |
| `modules/administration/import-job.ts:431` | T value bound for a column whose ORM type cannot carry it | .set({ stock: sqlˋ${after}ˋ }) |
| `modules/administration/import-job.ts:440` | T value bound for a column whose ORM type cannot carry it | .values({ product: productId, store: storeId, stock: sqlˋ${after}ˋ }); |
| `modules/administration/import-job.ts:454` | T value bound for a column whose ORM type cannot carry it | .set({ stock: sqlˋ${updated}ˋ }) |
| `modules/administration/import-job.ts:472` | T value bound for a column whose ORM type cannot carry it | .set({ is_avail: sqlˋ${available}ˋ, is_del: sqlˋ${deleted}ˋ }) |
| `modules/administration/import-job.ts:482` | T value bound for a column whose ORM type cannot carry it | .set({ is_avail: sqlˋ${available}ˋ, is_del: sqlˋ${deleted}ˋ }) |
| `modules/warehouse.ts:32` | E1 BigQuery (bound params) | const response: unknown = await client.query({ |
| `modules/order-history/search/native.ts:71` | T bound boolean flag | .leftJoin(anyStore, and(eq(anyStore.order, Order.id), sqlˋ${storeMode}ˋ)) |
| `modules/order-history/search/native.ts:76` | T bound boolean flag | sqlˋ${selected}ˋ, |
| `modules/order-history/search/native.ts:136` | T bound boolean flag | .leftJoin(anyStore, and(eq(anyStore.order, Order.id), sqlˋ${storeMode}ˋ)) |
| `modules/order-history/search/native.ts:141` | T bound boolean flag | sqlˋ${selected}ˋ, |
| `modules/order-history/search/native.ts:179` | T literal | ? sqlˋFALSEˋ |
| `modules/order-history/search/native.ts:211` | T CAST expression | eq(HyperlocalLocation.id, sqlˋCAST(${Order.location_id} AS SIGNED)ˋ), |
| `modules/order-history/search/native.ts:515` | T CAST expression | sqlˋCAST(${Order.id} AS CHAR) LIKE ${escapeLike(input.search)} ESCAPE '!'ˋ, |
| `modules/order-history/search/native.ts:516` | T CAST expression | sqlˋCAST(${Order.user} AS CHAR) LIKE ${escapeLike(input.search)} ESCAPE '!'ˋ, |
| `modules/order-history/search/queue.ts:81` | T CAST expression | eq(HyperlocalLocation.id, sqlˋCAST(${Order.location_id} AS SIGNED)ˋ), |
| `modules/order-history/search/queue.ts:86` | T CAST expression | and(eq(Order.location_type, 'SW'), eq(Store.id, sqlˋCAST(${Order.location_id} AS SIGNED)ˋ)), |
| `modules/catalog.ts:137` | T CASE expression | sqlˋcase when ${Product.parent_prod_id}=0 then ${Product.id} else ${Product.parent_prod_id} endˋ, |
| `modules/catalog.ts:170` | T CAST expression | like(sqlˋcast(${Product.id} as char)ˋ, pattern), |
| `modules/catalog.ts:268` | T qualified identifier of a builder subquery column | const pageId = sqlˋ${sql.identifier('catalog_page')}.${sql.identifier('page_id')}ˋ; |

## Generated: every typed `sql<T>` site

| site | category | code (backticks shown as ˋ) |
|---|---|---|
| `auth/device-handoff.ts:215` | T SQL function expression | .where(and(eq(sql<string>ˋlower(${PosUser.email})ˋ, email), eq(PosUser.is_active, true))) |
| `modules/catalog-details/snapshot.ts:25` | T CAST expression | id: sql<string>ˋcast(${Product.id} as char)ˋ, |
| `modules/catalog-details/snapshot.ts:27` | T scalar subquery built with the builder | barcode: sql<string>ˋcoalesce(nullif(${subquery |
| `modules/catalog-details/snapshot.ts:33` | T CASE expression | price: sql<string \| null>ˋcase when ${own} then ${Product.price} else ${parent.price} endˋ, |
| `modules/catalog-details/snapshot.ts:34` | T CASE expression | spl_price: sql< |
| `modules/catalog-details/snapshot.ts:37` | T scalar subquery built with the builder | exclusive_price: sql<number>ˋcoalesce(${subquery |
| `modules/catalog-details/queries.ts:80` | T aggregate / ANY_VALUE expression | return sql<string>ˋcount(distinct ${catalogPriceList.price})+if(count(*)>count(${catalogPriceList.price}),1,0) |
| `modules/catalog-details/queries.ts:83` | T scalar subquery built with the builder | return sql<string>ˋ${subquery |
| `modules/catalog-details/queries.ts:95` | T aggregate / ANY_VALUE expression | ? sql<string>ˋcoalesce(sum(case when ${search} then 1 else 0 end),0)ˋ |
| `modules/catalog-details/queries.ts:107` | T scalar subquery built with the builder | const categories = sql<string \| null>ˋ${subquery |
| `modules/catalog-details/queries.ts:112` | T scalar subquery built with the builder | const storeNames = sql<string \| null>ˋ${subquery |
| `modules/catalog-details/queries.ts:117` | T scalar subquery built with the builder | const exclusivePrice = sql<number \| null>ˋ${subquery |
| `modules/catalog-details/queries.ts:149` | T CAST expression | id: sql<string>ˋcast(${Product.id} as char)ˋ, |
| `modules/catalog-details/audit.ts:80` | T CASE expression | ? sql<string>ˋconcat(coalesce(${MUser.firstname},''),case when coalesce(${MUser.lastname},'')='' then '' else  |
| `modules/catalog-details/audit.ts:81` | T literal | : sql<string>ˋ''ˋ; |
| `modules/catalog-details/audit.ts:86` | T literal | storage_name: kind === 'storage' ? StoreStorage.storage_name : sql<string \| null>ˋnullˋ, |
| `modules/catalog-details/audit.ts:92` | T CASE expression | user: sql< |
| `modules/catalog-details/audit.ts:153` | T aggregate / ANY_VALUE expression | ? sql<string>ˋcoalesce(sum(case when ${match} then 1 else 0 end),0)ˋ |
| `modules/catalog-details/matrix.ts:169` | T aggregate / ANY_VALUE expression | ? sql<string>ˋcoalesce(sum(case when ${match} then 1 else 0 end),0)ˋ |
| `modules/catalog-details/matrix.ts:186` | T CASE expression | erpName: sql<string>ˋcoalesce(nullif(case when ${Product.parent_prod_id}=0 then ${Product.erp_product} else ${ |
| `modules/special-permission-history/service.ts:71` | T CAST expression | id: sql<string>ˋcast(${activity.id} as char)ˋ, |
| `modules/special-permission-history/service.ts:72` | T IS NOT NULL value expression | actorExists: sql<boolean>ˋ${PosUser.id} is not nullˋ.mapWith( |
| `modules/special-permission-history/service.ts:118` | T CAST expression | .select({ total: sql<string>ˋcast(count(*) as char)ˋ }) |
| `modules/customer-history/gateway.ts:48` | T aggregate / ANY_VALUE expression | amount: sql<number \| string>ˋIFNULL(ROUND(SUM((${parent.price}*${HasProduct.qty})-${HasProduct.price}),0),0)ˋ (legacy `users/views.py:879`) |
| `modules/customer-history/gateway.ts:72` | T aggregate / ANY_VALUE expression | store: sql<string>ˋCOUNT(${OrderStore.id})ˋ, |
| `modules/customer-history/gateway.ts:73` | T aggregate / ANY_VALUE expression | total: sql<string>ˋCOUNT(${Order.id})ˋ, |
| `modules/customer-history/gateway.ts:80` | T aggregate / ANY_VALUE expression | .select({ count: sql<string>ˋCOUNT(${Order.id})ˋ }) |
| `modules/customer-history/gateway.ts:92` | T CASE expression | cancelled: sql<string>ˋCOUNT(CASE WHEN ${Order.order_statuses}=4 THEN 1 END)ˋ, |
| `modules/customer-history/gateway.ts:93` | T CASE expression | returned: sql<string>ˋCOUNT(CASE WHEN ${Order.order_statuses}=6 THEN 1 END)ˋ, |
| `modules/customer-history/gateway.ts:99` | T aggregate / ANY_VALUE expression | .select({ score: sql<number \| string \| null>ˋAVG(${NpsFeedback.feedback})ˋ }) (legacy `users/views.py:970`) |
| `modules/customer-history/gateway.ts:109` | T SQL function expression | createdDate: sql<string \| null>ˋDATE(${Order.created_at})ˋ, |
| `modules/customer-history/gateway.ts:111`, `:122` | T scalar subquery built with the builder | isStoreOrder: sql<number \| string>ˋ${storeOrder}ˋ (`exists(...)` of a builder select) |
| `modules/customer-history/gateway.ts:141` | T window function | sql<number>ˋROW_NUMBER() OVER(PARTITION BY ${HasProduct.order} ORDER BY ${HasProduct.id} DESC)ˋ.as('position') |
| `modules/customer-history/gateway.ts:144` | T window function | total: sql<string>ˋCOUNT(*) OVER(PARTITION BY ${HasProduct.order})ˋ.as('total'), |
| `modules/gift-card-batches/service.ts:209` | T SQL function expression | sql<boolean>ˋCAST(CONVERT(CONVERT(${input.message} USING latin1) USING utf8mb4) AS BINARY)=CAST(${input.messag |
| `modules/gift-card-batches/service.ts:319` | T CAST expression | .select({ total: sql<string>ˋCAST(COUNT(*) AS CHAR)ˋ }) |
| `modules/gift-card-batches/service.ts:329` | T CAST expression | id: sql<string>ˋCAST(${GiftCardCollection.id} AS CHAR)ˋ, |
| `modules/administration-history/service.ts:167` | T SQL function expression | currentSchema: sql<string>ˋDATABASE()ˋ, |
| `modules/administration-history/service.ts:190` | T CAST expression | .select({ total: sql<string>ˋCAST(COUNT(*) AS CHAR)ˋ }) |
| `modules/administration-history/service.ts:203` | T CAST expression | id: sql<string>ˋCAST(${log.id} AS CHAR)ˋ, |
| `modules/administration-history/service.ts:205` | T CAST expression | actorId: sql<string>ˋCAST(${actor.id} AS CHAR)ˋ, |
| `modules/fulfillment/monitoring.ts:311` | T aggregate / ANY_VALUE expression | count: sql<number>ˋcount(distinct ${ExpressLineItem.order})ˋ, |
| `modules/fulfillment/monitoring.ts:323` | T aggregate / ANY_VALUE expression | const [count] = await db.select({ count: sql<number>ˋcount(*)ˋ }).from(selectedPairs); |
| `modules/fulfillment/shipping-label/service.ts:120` | T CASE expression | sql<number>ˋCASE WHEN ${or(isNull(HasProduct.awb), ne(HasProduct.awb, ''))} THEN 1 ELSE 0 ENDˋ.mapWith( |
| `modules/fulfillment/service.ts:838` | T aggregate / ANY_VALUE expression | .select({ count: sql<number>ˋcount(*)ˋ }) |
| `modules/checkout/payments/repository.ts:329` | T aggregate / ANY_VALUE expression | .select({ count: sql<number>ˋcount(*)ˋ }) |
| `modules/checkout/benefit-adjustments/repository.ts:80` | T CAST expression | money: sql<number>ˋCAST(${MUser.tss_money} AS CHAR)ˋ.mapWith(Number), |
| `modules/checkout/benefit-adjustments/repository.ts:81` | T CAST expression | points: sql<number>ˋCAST(${MUser.tss_points} AS CHAR)ˋ.mapWith(Number), |
| `modules/checkout/benefit-adjustments/repository.ts:82` | T CAST expression | cashback: sql<number>ˋCAST(${MUser.cashback} AS CHAR)ˋ.mapWith(Number), |
| `modules/checkout/customer-contact-authority.ts:25` | T SQL function expression (shared digest constant) | export const customerContactDigestSql = sql<string>ˋ${sql.raw(customerContactDigestExpression)}ˋ; |
| `modules/checkout/finalizer.ts:151` | T aggregate / ANY_VALUE expression | .select({ invoice: sql<string \| null>ˋmax(${OrderStore.order_invoice})ˋ }) |
| `modules/checkout/finalizer.ts:205` | T aggregate / ANY_VALUE expression | .select({ count: sql<number>ˋcount(*)ˋ }) |
| `modules/checkout/finalizer.ts:215` | T aggregate / ANY_VALUE expression | .select({ count: sql<number>ˋcount(*)ˋ }) |
| `modules/customer-insights/benefits.ts:76` | T scalar subquery built with the builder | vouchers: sql<string>ˋ${db |
| `modules/customer-insights/benefits.ts:78` | T CAST expression | .select({ count: sql<string>ˋCAST(COUNT(*) AS CHAR)ˋ }) |
| `modules/operational-reports/performance.ts:121` | T aggregate / ANY_VALUE expression | const total = sql<number>ˋsum(${HasProduct.price})ˋ, |
| `modules/operational-reports/performance.ts:122` | T aggregate / ANY_VALUE expression | name = sql< |
| `modules/operational-reports/performance.ts:125` | T aggregate / ANY_VALUE expression | storeName = sql<string \| null>ˋany_value(${Store.store_name})ˋ, |
| `modules/operational-reports/performance.ts:193` | T CAST expression | cashierId: sql<string \| null>ˋcast(any_value(${OrderStore.adminUserId}) as char)ˋ, |
| `modules/operational-reports/performance.ts:194` | T aggregate / ANY_VALUE expression | cashierName: sql< |
| `modules/operational-reports/performance.ts:197` | T aggregate / ANY_VALUE expression | performanceJson: sql<string>ˋany_value(${OrderStore.performanceJson})ˋ, |
| `modules/operational-reports/performance.ts:198` | T aggregate / ANY_VALUE expression | quantity: sql<string \| null>ˋsum(${HasProduct.qty})ˋ, |
| `modules/operational-reports/scheduled-data.ts:165` | T CAST expression | orderId: sql<string \| null>ˋCAST(${Order.id} AS CHAR)ˋ, |
| `modules/operational-reports/scheduled-data.ts:166` | T aggregate / ANY_VALUE expression | createdAt: sql<string \| null>ˋANY_VALUE(${Order.created_at})ˋ, |
| `modules/operational-reports/scheduled-data.ts:167` | T CAST expression | storeId: sql<string \| null>ˋCAST(ANY_VALUE(${Store.id}) AS CHAR)ˋ, |
| `modules/operational-reports/scheduled-data.ts:168` | T aggregate / ANY_VALUE expression | storeName: sql<string \| null>ˋANY_VALUE(${Store.store_name})ˋ, |
| `modules/operational-reports/scheduled-data.ts:169` | T aggregate / ANY_VALUE expression | acceptedAt: sql<string>ˋANY_VALUE(${HyperlocalOrderLog.updated_at})ˋ, |
| `modules/operational-reports/scheduled-data.ts:186` | T CAST expression | orderId: sql<string>ˋCAST(${Order.id} AS CHAR)ˋ.as('orderId'), |
| `modules/operational-reports/scheduled-data.ts:187` | T CAST expression | storeId: sql<string>ˋCAST(${Order.location_id} AS CHAR)ˋ.as('storeId'), |
| `modules/operational-reports/scheduled-data.ts:190` | T CAST expression | mainStoreId: sql<string \| null>ˋCAST(${HyperlocalOrderLog.main_location_id} AS CHAR)ˋ.as( |
| `modules/operational-reports/scheduled-data.ts:195` | T window function | sql<number>ˋROW_NUMBER() OVER(PARTITION BY ${Order.id} ORDER BY ${HyperlocalOrderLog.id})ˋ.as( |
| `modules/operational-reports/scheduled-data.ts:231` | T CAST expression | orderId: sql<string>ˋCAST(${HyperlocalToOnlineOrderLog.order_id} AS CHAR)ˋ, |
| `modules/operational-reports/scheduled-data.ts:250` | T CAST expression | orderId: sql<string \| null>ˋCAST(${HyperlocalFdLog.order_id} AS CHAR)ˋ, |
| `modules/operational-reports/scheduled-data.ts:273` | T CAST expression | orderId: sql<string>ˋCAST(${HyperlocalAvailabilityLog.order_id} AS CHAR)ˋ, |
| `modules/operational-reports/scheduled-data.ts:293` | T CAST expression | .select({ orderId: sql<string>ˋCAST(${Order.id} AS CHAR)ˋ, isApp }) |
| `modules/operational-reports/scheduled-data.ts:308` | T CAST expression | orderId: sql<string>ˋCAST(${Order.id} AS CHAR)ˋ, |
| `modules/operational-reports/scheduled-data.ts:309` | T CAST expression | totalDelay: sql< |
| `modules/operational-reports/hyperlocal-daily.ts:197` | T aggregate / ANY_VALUE expression | sku_id: sql<string>ˋANY_VALUE(${HasProduct.product})ˋ, |
| `modules/operational-reports/hyperlocal-daily.ts:198` | T SQL function expression | customer_name: sql<string \| null>ˋCONCAT(${Order.first_name},' ',${Order.last_name})ˋ, |
| `modules/operational-reports/hyperlocal-daily.ts:199` | T aggregate / ANY_VALUE expression | qty: sql<string>ˋSUM(${HasProduct.qty})ˋ, |
| `modules/operational-reports/hyperlocal-daily.ts:200` | T aggregate / ANY_VALUE expression | amount: sql<string>ˋROUND(SUM(COALESCE(${HasProduct.pre_gst_amt},0)*(1+COALESCE(${HasProduct.gst},0)/100)),2)ˋ |
| `modules/operational-reports/hyperlocal-daily.ts:201` | T aggregate / ANY_VALUE expression | order_status: sql<string \| null>ˋANY_VALUE(${OrderStatus.display_name})ˋ, |
| `modules/operational-reports/hyperlocal-daily.ts:351` | T aggregate / ANY_VALUE expression | allocation_date: sql< |
| `modules/operational-reports/hyperlocal-daily.ts:354` | T aggregate / ANY_VALUE expression | pack_date: sql< |
| `modules/operational-reports/hyperlocal-daily.ts:357` | T aggregate / ANY_VALUE expression | pickup_date: sql< |
| `modules/operational-reports/hyperlocal-daily.ts:360` | T aggregate / ANY_VALUE expression | delivery_date: sql< |
| `modules/operational-reports/feedback-dimensions.ts:50` | T CAST expression | .select({ id: sql<string>ˋCAST(${UserStore.store_id} AS CHAR)ˋ }) |
| `modules/operational-reports/acceptance.ts:60` | T SQL function expression | const elapsed = sql<number>ˋtimestampdiff(second,${HyperlocalOrderLog.created_at},${HyperlocalOrderLog.updated |
| `modules/operational-reports/acceptance.ts:61` | T CASE expression | timeTaken = sql<string>ˋconcat(case when floor(${elapsed}/86400)>0 then concat(floor(${elapsed}/86400),'D ') e |
| `modules/operational-reports/feedback.ts:136` | T aggregate / ANY_VALUE expression | .select({ count: sql<number>ˋcount(*)ˋ }) |
| `modules/operational-reports/returned-orders.ts:78` | T aggregate / ANY_VALUE expression | const refunded = sql< |
| `modules/operational-reports/returned-orders.ts:81` | T aggregate / ANY_VALUE expression | mode = sql< |
| `modules/operational-reports/returned-orders.ts:86` | T aggregate / ANY_VALUE expression | return_id: sql<string>ˋany_value(${ReturnOrder.id})ˋ, |
| `modules/operational-reports/returned-orders.ts:87` | T aggregate / ANY_VALUE expression | store_name: sql<string \| null>ˋany_value(${Store.store_name})ˋ, |
| `modules/operational-reports/returned-orders.ts:88` | T aggregate / ANY_VALUE expression | order_id: sql<string>ˋany_value(${ReturnOrder.order_id})ˋ, |
| `modules/operational-reports/returned-orders.ts:89` | T aggregate / ANY_VALUE expression | prod_id: sql<string>ˋany_value(${ReturnOrder.prod_id})ˋ, |
| `modules/operational-reports/returned-orders.ts:90` | T aggregate / ANY_VALUE expression | qty: sql<number>ˋany_value(${ReturnOrder.qty})ˋ, |
| `modules/operational-reports/returned-orders.ts:93` | T aggregate / ANY_VALUE expression | reason: sql<string \| null>ˋany_value(${ReversePickupReason.reason})ˋ, |
| `modules/operational-reports/returned-orders.ts:94` | T aggregate / ANY_VALUE expression | sub_reason: sql<string \| null>ˋany_value(${SubReason.sub_reason})ˋ, |
| `modules/operational-reports/returned-orders.ts:95` | T aggregate / ANY_VALUE expression | comment: sql<string \| null>ˋany_value(${ReturnOrder.comment})ˋ, |
| `modules/operational-reports/returned-orders.ts:96` | T aggregate / ANY_VALUE expression | order_date: sql<string>ˋany_value(${HasProduct.created_at})ˋ, |
| `modules/operational-reports/returned-orders.ts:97` | T aggregate / ANY_VALUE expression | created_at: sql<string>ˋany_value(${ReturnOrder.created_at})ˋ, |
| `modules/operational-reports/returned-orders.ts:98` | T aggregate / ANY_VALUE expression | original_order_id: sql<string \| null>ˋany_value(${Order.parent_order_id})ˋ, |
| `modules/operational-reports/returned-orders.ts:220` | T aggregate / ANY_VALUE expression | .select({ count: sql<number>ˋcount(distinct ${HasProduct.id})ˋ }) |
| `modules/finance/history.ts:197` | T aggregate / ANY_VALUE expression | .select({ count: sql<number>ˋcount(*)ˋ }) |
| `modules/finance/ledger.ts:285` | T aggregate / ANY_VALUE expression | cash: sql<string>ˋcoalesce(sum(${OrderStore.offline_payment}),0)ˋ, |
| `modules/finance/ledger.ts:295` | T arithmetic expression | sql<number>ˋ(${OrderStore.offline_payment}+${OrderStore.online_payment}+${OrderStore.online_other_payment})ˋ, |
| `modules/finance/service.ts:95` | T aggregate / ANY_VALUE expression | orderCount: sql<number>ˋcount(*)ˋ, |
| `modules/finance/service.ts:96` | T aggregate / ANY_VALUE expression | cash: sql<string>ˋcoalesce(sum(${OrderStore.offline_payment}),0)ˋ, |
| `modules/finance/service.ts:97` | T aggregate / ANY_VALUE expression | card: sql<string>ˋcoalesce(sum(${OrderStore.online_payment}),0)ˋ, |
| `modules/finance/service.ts:98` | T aggregate / ANY_VALUE expression | district: sql<string>ˋcoalesce(sum(case when ${district} then ${OrderStore.online_other_payment} else 0 end),0 |
| `modules/finance/service.ts:99` | T aggregate / ANY_VALUE expression | onlineOther: sql<string>ˋcoalesce(sum(case when ${or(isNull(OrderStore.district_transaction_id), eq(OrderStore |
| `modules/finance/service.ts:109` | T arithmetic expression | sql<number>ˋ(${OrderStore.offline_payment}+${OrderStore.online_payment}+${OrderStore.online_other_payment})ˋ, |
| `modules/finance/service.ts:127` | T aggregate / ANY_VALUE expression | .select({ cashRefund: sql<string>ˋcoalesce(sum(${AmountToBeRefundedLog.refunded_amt}),0)ˋ }) |
| `modules/administration/inventory.ts:74` | T scalar subquery built with the builder | barcode: sql<string \| null>ˋ${db |
| `modules/administration/terminal-directory.ts:32` | T SQL function expression | sql<string>ˋCONVERT(${value} USING utf8mb4) COLLATE utf8mb4_unicode_ciˋ.as(alias); |
| `modules/administration/service.ts:1096` | T aggregate / ANY_VALUE expression | .select({ total: sql<string>ˋcoalesce(sum(${StockStorage.stock}),0)ˋ }) |
| `modules/order-history/online-detail/native.ts:80` | T CAST expression | rows: sql<string>ˋCAST(COUNT(*) AS CHAR)ˋ, |
| `modules/order-history/online-detail/native.ts:81` | T CAST expression | bytes: sql<string>ˋCAST(COALESCE(SUM(OCTET_LENGTH(${PosTransactionLog.pay_dict})+COALESCE(OCTET_LENGTH(${PosTr |
| `modules/order-history/search/native.ts:49` | T literal | const zero = sql<string>ˋ'0'ˋ; |
| `modules/order-history/search/native.ts:56` | T CAST expression | .select({ count: sql<string>ˋCAST(COUNT(*) AS CHAR)ˋ }) |
| `modules/order-history/search/native.ts:109` | T CAST expression | rowAny: storeMode ? sql<string>ˋCAST(${anyStore.id} AS CHAR)ˋ : zero, |
| `modules/order-history/search/native.ts:110` | T CAST expression | rowMatched: selected ? sql<string>ˋCAST(${matchedStore.id} AS CHAR)ˋ : zero, |
| `modules/order-history/search/native.ts:111` | T SQL function expression | phoneWeight: sql<string>ˋLOWER(HEX(WEIGHT_STRING(${Order.phone_no} AS CHAR(32))))ˋ, |
| `modules/order-history/search/native.ts:112` | T SQL function expression | userPhoneWeight: sql< |
| `modules/order-history/search/native.ts:115` | T SQL function expression | emailWeight: sql<string \| null>ˋLOWER(HEX(WEIGHT_STRING(${MUser.email} AS CHAR(96))))ˋ, |
| `modules/order-history/search/native.ts:116` | T SQL function expression | userFirstKey: sql<string \| null>ˋLOWER(HEX(WEIGHT_STRING(${MUser.firstname} AS CHAR(32))))ˋ, |
| `modules/order-history/search/native.ts:117` | T SQL function expression | methodKey: sql<string \| null>ˋLOWER(HEX(WEIGHT_STRING(${PaymentMethod.name} AS CHAR(255))))ˋ, |
| `modules/order-history/search/native.ts:118` | T SQL function expression | paymentKey: sql< |
| `modules/order-history/search/native.ts:191` | T CAST expression | inArray(sql<string>ˋCAST(${ExpressLineItem.store_id} AS CHAR)ˋ, ids), |
| `modules/order-history/search/native.ts:201` | T CAST expression | inArray(sql<string>ˋCAST(${Order.location_id} AS CHAR)ˋ, ids), |
| `modules/order-history/search/native.ts:212` | T CAST expression | inArray(sql<string>ˋCAST(${HyperlocalLocation.store_id} AS CHAR)ˋ, ids), |
| `modules/order-history/search/native.ts:224` | T CAST expression | : eq(sql<string>ˋCAST(${Order.location_id} AS CHAR)ˋ, scope.checkedInStoreId ?? '0'), |
| `modules/order-history/search/native.ts:306` | T CAST expression | manual: sql<string>ˋCAST(${OrderStore.is_manually_paid} AS CHAR)ˋ, |
| `modules/order-history/search/native.ts:307` | T CAST expression | offline: sql<string>ˋCAST(${OrderStore.is_offline_order} AS CHAR)ˋ, |
| `modules/order-history/search/native.ts:308` | T CAST expression | shopify: sql<string>ˋCAST(${OrderStore.is_shopify_order} AS CHAR)ˋ, |
| `modules/order-history/search/native.ts:321` | T CASE expression | created: sql<string>ˋCAST(CASE WHEN ${PosTerminalTransaction.platform}='txn_created' THEN 1 ELSE 0 END AS CHAR |
| `modules/order-history/search/native.ts:322` | T CASE expression | completed: sql<string>ˋCAST(CASE WHEN ${PosTerminalTransaction.platform}='txn_completed' THEN 1 ELSE 0 END AS  |
| `modules/order-history/search/native.ts:323` | T CAST expression | active: sql<string>ˋCAST(${PosTerminalTransaction.is_active} AS CHAR)ˋ, |
| `modules/order-history/search/native.ts:334` | T CASE expression | created: sql<string>ˋCAST(CASE WHEN ${PosPaytmTransaction.platform}='txn_created' THEN 1 ELSE 0 END AS CHAR)ˋ, |
| `modules/order-history/search/native.ts:335` | T CASE expression | completed: sql<string>ˋCAST(CASE WHEN ${PosPaytmTransaction.platform}='txn_completed' THEN 1 ELSE 0 END AS CHA |
| `modules/order-history/search/native.ts:336` | T CAST expression | active: sql<string>ˋCAST(${PosPaytmTransaction.is_active} AS CHAR)ˋ, |
| `modules/order-history/search/native.ts:344` | T CASE expression | invalid: sql<string>ˋCAST(SUM(CASE WHEN CAST(${HasProduct.status} AS BINARY) IN (_binary'DELIVERED',_binary'PL |
| `modules/order-history/search/service.ts:67` | T CAST expression | .select({ count: sql<string>ˋCAST(COUNT(DISTINCT ${ExpressLineItem.order}) AS CHAR)ˋ }) |
| `modules/order-history/search/service.ts:73` | T SQL function expression | eq(sql<string>ˋDATE(${column})ˋ, today), |
| `modules/order-history/search/service.ts:181` | T CAST expression | id: sql<string>ˋCAST(${Store.id} AS CHAR)ˋ, |
| `modules/order-history/search/service.ts:189` | T CAST expression | .select({ id: sql<string>ˋCAST(${PaymentMethod.id} AS CHAR)ˋ, name: PaymentMethod.name }) |
| `modules/order-history/search/service.ts:194` | T CAST expression | id: sql<string>ˋCAST(${PaymentStatus.id} AS CHAR)ˋ, |
| `modules/order-history/search/service.ts:201` | T CAST expression | id: sql<string>ˋCAST(${OrderStatus.id} AS CHAR)ˋ, |
| `modules/order-history/search/queue.ts:96` | T CAST expression | eq(sql<string>ˋCAST(${Order.location_id} AS CHAR)ˋ, storeId), |
| `modules/order-history/search/queue.ts:119` | T CAST expression | eq(sql<string>ˋCAST(${Order.location_id} AS CHAR)ˋ, storeId), |
| `modules/catalog.ts:111` | T optimizer hint on a column (pre-existing; `sql.raw` of a shipped constant) | id: sql<bigint>ˋ${sql.raw(hint)} ${Product.id}ˋ, |
| `modules/catalog.ts:113` | T CASE expression | erp: sql<string>ˋcoalesce(nullif(case when ${Product.parent_prod_id}=0 then ${Product.erp_product} else ${pare |
| `modules/catalog.ts:116` | T CASE expression | price: sql<string>ˋcase when ${Product.parent_prod_id}=0 then ${Product.price} else coalesce(${parent.price},0 |
| `modules/catalog.ts:117` | T CASE expression | special: sql<string>ˋcase when ${Product.parent_prod_id}=0 then ${Product.spl_price} else coalesce(${parent.sp |
| `modules/catalog.ts:124` | T scalar subquery built with the builder | barcode: sql<string \| null>ˋ${reader |
| `modules/catalog.ts:130` | T scalar subquery built with the builder | exclusive: sql<string \| null>ˋ${reader |
| `modules/catalog.ts:219` | T optimizer hint on a column | id: sql<bigint>ˋ/*+ JOIN_ORDER(products_gs1, products, product_store) */ ${Product.id}ˋ.as( |
| `modules/catalog.ts:241` | T optimizer hint on a column | id: sql<bigint>ˋ/*+ JOIN_ORDER(product_store, products) INDEX(product_store idx_store_id_stock_is_avail_is_d |
| `modules/administration/inventory.ts:64` | T optimizer hint on a column | id: sql<bigint>ˋ/*+ JOIN_ORDER(products, product_store) */ ${Product.id}ˋ.mapWith( |
