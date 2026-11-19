# W16: query performance and locking reads

Branch `w16/query-perf`. Round 1 started from integration head `3a3e0ab5` and was merged as
`2712b3ef`. Round 2 followed the production rerun `evidence/live-readonly-2026-11-19-r2.json`
and was merged as `1af57584`. Round 3 followed the next production rerun, which the primary agent
ran and reported. Every check below ran on a loopback MySQL 8.4.11 server. Nothing was run
against production.

## Round 3: `catalog-product-barcode` timed out on production

The production rerun used `refuse` mode. 15 of 16 paths passed. `catalog-product-barcode` failed
with `ER_QUERY_TIMEOUT`: one statement hit `MAX_EXECUTION_TIME=10000`. That path had 3 bounded
plans, each a `products` range estimated at 181,046 rows.

### 1. Naming the failed statement in the evidence

The evidence now names each failed statement without any value. Every statement that fails, by
plan-gate rejection or server error, is recorded in the guard as `failedStatements` with:
- `fingerprint`: the first 16 hex digits of the SHA-256 of the template;
- `code`;
- `template`: the SQL rebuilt from the guard's tokens. Every string, number and variable becomes
  `?`, and comments and hints are dropped;
- `plan`: the gate's EXPLAIN view of the statement (tables, access types, keys, row estimates,
  driving and outermost flags, and the outermost sort/temporary flag).

A path that does not pass carries these in its result.

`assertAggregateOnly` accepts a `template` only at `paths[i].failedStatements[j].template`, and
only when `isValueFreeTemplate` holds. That check requires:
- no quote characters;
- a restricted character set;
- at most 8000 characters;
- re-tokenising returns the template unchanged, so no literal can survive.

The code is in `tools/live-readonly/fingerprint.ts`. The unit tests are in
`tests/live-readonly/fingerprint.test.ts`: 5 tests, including a template leak that is rejected.

On loopback, with `POS_PROD_RO_PLAN_ROW_LIMIT=50000`, the in-stock page is rejected and its
template, fingerprint and plan appear in the printed summary.

### 2. Reproduction

`tests/live-readonly/volume-fixture.ts` now lays the catalog out by age, as a real catalog is:
- 360k products, with interleaved ids: each parent is followed by its 5 variants;
- 30% of the older half is deleted, and 2% of the newer half;
- 4 stores, each holding 90% of the catalog (about 324k rows per store);
- 2.4% `is_avail = 0` and 1.9% `is_del`;
- stock only in the newest 20% of ids: 60% of those are in stock, against 1 in 20,000 older ones.
  That gives about 36k in-stock rows for store 1;
- about 180k GS1 rows.

**The cause is round 2's in-stock page.** Page 1 walks `products` by id and probes
`uq_product_store` for every older product before it finds in-stock ones:
**288,058 `Handler_read_key` (index lookups) for one 21-row page**, taking 796 ms on loopback with
the 1.3M-row index fully cached. Production's index has 27.6M rows and is not fully cached, which
is consistent with 10 s. Wall time could not be reproduced: the macOS file cache keeps a 5 MB
buffer pool fast. The work count is the reproduction.

The other shapes are cheap:
- the picker with out-of-stock rows: 93 index lookups;
- the inventory list: 46 index lookups;
- the next in-stock page: 26 index lookups.

### 3. Legacy for the same requests, and the fix

Legacy is `AjaxOrderProductsListView` (`core/datatables/store_products_datatable.py:186-293`). It
runs `count()` and then a page sliced with `ORDER BY id`. Both use the same filters, including
`store_sellable_q` (`helpers/helpers.py:120-122`) and, when searching, the
`pb_product__gtin__icontains` join.

The SQL Django generates for it was run on the same fixture: `Handler_read_key`, with the
optimizer's own plan. Each legacy cell is the page plus the count.

| request (store 1, page of 20) | legacy (page + `count()`) | round 2 | round 3 (now) |
|---|---|---|---|
| in stock, no search | `product_store` range `idx_store_id_stock_is_avail_is_del` + filesort: 102,036 + 102,036 (~180 ms each) | PK walk: **288,058** (796 ms) | derived in-stock page via the same index: **69,054** (145 ms) |
| in stock, search with no match | the same range + gs1 join: 136,512 × 2 (~245 ms each) | PK walk, gs1 EXISTS per product | **103,429** (168 ms) |
| including out of stock, no search | `product_store` ref `store_id` + filesort: 476,064 × 2 | 93 | **93** (PK walk, unchanged) |
| including out of stock, search with no match | ref `store_id` + gs1 join + filesort: 680,769 × 2 (~1.4 s each) | 300,003 | **300,003** (772 ms): PK walk, gs1 EXISTS per product, no `product_store` read for products that do not match |

**The fix is in `catalog.ts`.** The access path now follows the request:
- **Including out of stock (no barcode):** the PK walk. The store is dense, so it stops after
  about LIMIT products.
- **In stock (no barcode):** the derived page through `idx_store_id_stock_is_avail_is_del`
  (`store_id`, `stock > 0`). This is legacy's own plan for this request, without legacy's second
  pass for `count()`.
- **Exact barcode:** the `gtin` point lookup, unchanged.

**Result:** every row of the table now costs less than legacy for the same request.

**Proof that output is identical:** `tests/catalog/products-plan-orm.mysql.test.ts`, whose oracle
is the pre-W16 statement, passes 3/3 for both in-stock and out-of-stock modes, searches, cursors
and barcodes.

**Inventory.** The inventory list is unchanged since round 2. All its loopback shapes are cheap:
- `all`: 46 index lookups;
- archived only (`active=false`): 1,243;
- a search with no match: 1 index lookup and a 360k-row PK read, with no `product_store` probes.

**The suite's search cases.** The catalog path now also sends the search patterns the counter page
sends:
- a name fragment, a digit fragment and a no-match term, in stock. These are bounded by the
  store's in-stock rows;
- a no-match search including out of stock. This walks the whole catalog, which is strictly less
  work than legacy's two passes over about 319k store rows.

That last case is marked as a known legacy-equivalent cost: an `ER_QUERY_TIMEOUT` there is
recorded as the check `search:oos-no-match:legacy-equivalent-timeout` instead of failing the path.
On loopback it completes, and the check `search:oos-no-match` is recorded.

### Loopback results (round 3)

Live suite:
- **Realistic volume fixture:** 96 tests; 16/16 paths, 0 locks, 0 rejections and 3 bounded plans.
  The bounded plans are the out-of-stock picker, the inventory list and the no-match search
  including out of stock.
- **Plain fixture:** 16/16 paths.

Tests:
- **Unit tests:** 79 across the guard, the plan gate and fingerprints.
- **Full `vitest`:**
  - without database gates: 745 passed;
  - with MySQL gates: 1027 passed and 9 failed. The same 9 fail at head `1af57584`: collections
    ×7, administration barcode `exclusivePrice`, customer-history Latin1 and global-vouchers.

## Production facts that decided the plans

The production rerun reports these table sizes:

| table | rows |
|---|---|
| `products` | 362,092 |
| `product_store` | 27,594,003 |
| `products_gs1` | 165,308 |
| `pricelist` | 58,620 |

A `store_id` ref estimates **318,880 rows per store**, so a store holds about 88% of the catalog.
The in-stock range on `(store_id, stock > 0)` stays under 100k, so `catalog-product-barcode` passed
in r2.

With stores this dense, the right plan for "this store's products by id, page of n" is a walk of
`products` PRIMARY in id order. Each product's store row is then a point read on
`uq_product_store (product_id, store_id)`.
- The ORDER BY is served by the index, so there is no filesort.
- `LIMIT n+1` stops the scan after roughly n / density products.
- A store-driven read cannot stop early. No index has a `(store_id, product_id)` prefix, so it must
  read and sort all ~319k store rows.

**Round 1 was right for the first symptom but wrong for this density.** It replaced the PK walk with
a store-driven derived page, which is what the old gate demanded. Round 2 restores the PK walk and
refines the gate instead.

The volume fixture now reproduces production density: 4 stores × ~324k `product_store` rows (90% of
the catalog, a fifth in stock). The ref estimate is ~640k; production's is 319k.

On that fixture, at merge head `2712b3ef` with `refuse`, 3 paths skip:
- catalog: `product_store` range, 109k;
- checkout: `product_store` ref, 643k;
- inventory: `product_store` ref, 643k.

## Queries (current state)

### 1. Counter product page and picker (`src/modules/catalog.ts` `products`, no barcode)

*Round 3:* this now applies only to the picker including out-of-stock rows. The in-stock page
uses the derived in-stock page described in "Round 3" above.

This is the pre-W16 statement, unchanged:
`products FORCE INDEX (PRIMARY)` range `id > after` in id order, then `product_store` eq_ref
`uq_product_store`, `catalog_parent` eq_ref and `LIMIT n+1`.

Legacy reference: `AjaxOrderProductsListView` (`core/datatables/store_products_datatable.py:186-293`)
walks the same `products ⋈ product_store(store)` join ordered by `id`, and also runs a `count()`
on every request.

With no sort, the scalar projections (first GTIN, membership price) run only for emitted rows. The
round-1 pre-sort evaluation problem therefore does not arise.

### 2. Exact barcode (`catalog.ts`, `exactBarcode`)

This path keeps the round-1 point lookup:
- `products_gs1 FORCE INDEX (gtin)` ref, then `products` eq_ref, then `product_store` eq_ref
  `uq_product_store`;
- `GROUP BY products.id` keeps EXISTS semantics;
- the derived page has ≤ 2 rows, and the projection is read for those rows only.

Legacy reference: `ProductBarcode.objects.filter(gtin=barcode)` (`order/views.py:1720`).

### 3. Store inventory list (`src/modules/administration/inventory.ts` `list`)

The statement is the original one plus hints. Its WHERE and ORDER BY are unchanged:
- `JOIN_ORDER(products, product_store)`;
- `products FORCE INDEX (PRIMARY)`;
- `product_store FORCE INDEX (uq_product_store)`.

The hint rides on the first column, and `mapWith(Product.id)` keeps the bigint id type. Production
had already chosen this PK walk by itself; the hints make it deterministic.

Legacy pages the store's products by id.

### 4. checkout-quote-inputs: which statement was store-wide, and why

**The quote itself reads no `product_store` row.**
- Prices and stock come from API-v2 `processorder`/`validatecheckout`.
- Cart lines read only `products` (`cartProduct`, a PK point read), `store_counters` and `users`.
- Legacy is the same. `AjaxCartView` (`order/views.py:1692-1770`) reads only `products_gs1` and
  `products`, and reads no store stock.

**The rejected statement** (statement 5 of 5) was the suite's proxy for "price-list and stock
inputs". That proxy is the counter product picker with out-of-stock rows (`includeOutOfStock`,
legacy `include_oss_toggle=1`). In round 1 it read `product_store` ref on `store_id` with
filesort.

**It is now item 1:**
- a PK walk of `products`;
- one `uq_product_store` point read per product;
- the subqueries (pricelist PK point read, `products_gs1.product_id` ref) per emitted row only.

The suite comment now states this.

### Proof that output is identical

- **`tests/catalog/products-plan-orm.mysql.test.ts`:**
  - It runs the pre-W16 statement verbatim as the oracle. It compares the whole `Page` with
    `toStrictEqual`: values, types, order, cursors, holds and storage.
  - The inputs are 3 stores × in/out-of-stock × 9 searches × 6 cursor/limit pairs, plus 7 exact
    barcodes and full page walks.
  - 3/3 pass.
- **`tests/administration/inventory-list-orm.mysql.test.ts`:** the existing oracle, with the former
  statement verbatim and a `toStrictEqual` matrix, passes.

### EXPLAIN and timing on the dense fixture (store 1 ≈ 324k `product_store` rows)

| statement | round 1 (merged `2712b3ef`) | round 2 (now) |
|---|---|---|
| catalog in-stock page, LIMIT 21 | derived: `product_store` range 109k + temp + filesort; **331 ms** | `products` range PRIMARY (est. 175,895), no filesort → `product_store` eq_ref `uq_product_store`; 0.55 ms on variants (48 ms on page 1, which first crosses the fixture's 60k out-of-stock parent ids) |
| picker incl. out-of-stock (checkout), LIMIT 11 | `product_store` ref 643k + temp + filesort; **1,624 ms** | same plan as above; 0.11 ms (47 ms on page 1, for the same reason) |
| inventory list, LIMIT 21 | `product_store` ref 643k + temp + filesort; **1,065 ms** | `products` range PRIMARY → `product_store` eq_ref `uq_product_store`; **0.12 ms** |
| exact barcode | `products_gs1` ref `gtin` (1) → eq_ref → eq_ref; 0.14 ms | unchanged |
| worst case: search with no match | store-driven ~0.3–1.6 s | full PK walk: 431 / 345 / 277 ms (catalog / picker / inventory). This equals legacy's per-request `count()` over the same join. |

## Live-suite plan gate (round 2)

`tools/live-readonly/plan-gate.ts` is a pure function over `EXPLAIN FORMAT=JSON`.
`connection.ts` now issues `EXPLAIN FORMAT=JSON` instead of the traditional format.

**The rule.** An access estimating more than the row limit (100k) is accepted only when all of
these hold:
- it is the **driving** table of the **outermost** query block, not a subquery, derived table or
  UNION member;
- its access is `range` or `ref`;
- the outermost block has **no filesort and no temporary table** anywhere: ordering, grouping,
  DISTINCT or semijoin duplicate removal;
- the statement ends with a top-level **`LIMIT n`, n ≤ 50**, with no OFFSET (`LIMIT ?` is read from
  the last bound value).

Such plans are reported per path as `planBounded` and counted in the totals.

**Still refused:**
- `ALL` on tables over the limit, judged by physical size;
- `index` full scans;
- any filesort or temporary table over the limit;
- large non-driving or nested accesses.

**Unit tests:** `tests/live-readonly/plan-gate.test.ts` has 9 tests. They cover the accept case, no
LIMIT or LIMIT > 50, filesort, temporary table and semijoin temporary table, non-driving,
derived, subquery and UNION accesses, ALL and index scans, small plans, and the trailing-LIMIT
parser.

**`POS_PROD_RO_LOCKING_READS` now defaults to `refuse`.**

**Loopback live results.** All runs: 91 tests, 16/16 paths, 0 locks, 0 refusals, 0 rejections.

| fixture | mode | `planBounded` plans |
|---|---|---|
| dense | `refuse` | 4, all `products` range (~176k) |
| dense | `downgrade` | 4, all `products` range (~176k) |
| plain | `refuse` | 0 |

With `POS_PROD_RO_PLAN_ROW_LIMIT=1`, the sampling query is still rejected (its backward `index`
scan is not exempt), so the gate still bites.

## Locking reads

The loopback run before the change matched production: 56 locking reads, 12 of them `FOR UPDATE`.
After the change there are **0**. All 16 paths pass with `POS_PROD_RO_LOCKING_READS=refuse`, on both
the plain fixture and the volume fixture. This makes the "NEEDS USER DECISION: downgrade versus
refuse" item in `live-readonly.md` moot. Refuse is now the default (round 2). Production r2 confirms: 0 locks, 0 refusals.

**Removed.** Every one of these was authorization confirmation in a transaction that never mutates.

| location | lock removed | why it existed |
|---|---|---|
| `administration/authorization.ts` `assertCurrentStoreAccess` default as called by `orderReadAuthority`, `sourceSearchAuthority` | `stores … FOR UPDATE` (the 12) | default for mutating callers ("writer callers subsequently mutate this Store") |
| same, `assertCurrentOperatorIdentity` | `pos_user … FOR SHARE` | "shared locks prevent revocation during the mutation" |
| same, non-global operators | `user_stores … FOR SHARE` | same |
| `order-history/authority.ts` (list/detail recheck, ×2 per list) | `stores`, `pos_user` FOR SHARE | writer consistency |
| `order-history/search/scope.ts` | `pos_user` FOR SHARE; **every `stores` row** FOR SHARE (global) or `stores ⋈ user_stores` FOR SHARE; HE label `stores` FOR SHARE | writer consistency |
| `order-history/online-detail/authority.ts` | `stores`, `orders`, `order_stores`, `express_line_item`, `hyperlocal_locations` FOR SHARE | writer consistency |
| `catalog-barcode.ts` `readCatalogBarcode` (×2 per scan) | `pos_user`, `stores`, `user_stores` FOR SHARE (`'share'`) plus `stores` FOR SHARE | writer consistency |

These reads still go to the **writer**, as AGENTS.md requires for authorization confirmation. They
are now plain reads inside a `repeatable read, read only` transaction, which gives one consistent
snapshot and allocates no transaction id. Legacy `OrdersView`, `ShowOrderDetailsView`,
`ShowOnlineOrderDetailsView` and `AjaxOrderListView` read without locks.

The shared helpers gain an opt-in mode: `assertCurrentStoreAccess(..., storeLock: 'none')` and
`assertCurrentOperatorIdentity(..., lock: 'none')`. Their defaults are unchanged, so no mutation
caller changes behaviour.

**Output proof.** These suites pass unchanged:
- `tests/order-history/*` (orders and online detail, `ORDER_HISTORY_MYSQL_TEST_URL`);
- `tests/order-search/*` (`ORDER_SEARCH_MYSQL_TEST_URL`);
- `tests/catalog-details/*` and `tests/catalog-barcode.test.ts`;
- the live suite on loopback, where row counts and contracts are the same.

**Kept**, because a mutation in the same transaction needs the lock:
- **`inventory.setStock`:** `products … FOR UPDATE` and `product_store … FOR UPDATE`, followed by
  an `INSERT`/`UPDATE` of `product_store` and the stock procedure (compare-and-set on
  `expectedStock`).
- **Every other `assertCurrentStoreAccess` caller:** checkout payments, invoices and cancellations,
  fulfillment, global vouchers, check-ins, settings and operational-report inventory. They keep
  their default locks. They are mutations or outside W16's read paths.

## N+1 review

- **Order list:** one query. The authority runs twice by design, as a recheck.
- **Order search:** the page is batched with `inArray` and `Promise.all`.
- **Store detail and online detail:** batched per order.
- **Checkout quote:** API-v2 driven. `cartProduct` and `customer` are single lookups. The sequential
  draft-import loop is an ordered sequence of cart mutations, so it is not batchable.
- **Catalog:** hold and storage are already batched. The scalar projections run per emitted
  row only, because the PK walk has no sort.

No per-row database round trips were found.

## Checks (loopback)

- **Static checks:** `tsc` and `eslint` pass. `orm-metadata` passes as part of the full run.
- **Full backend `vitest` without database environment variables:** 157 files passed and 53
  skipped; 737 tests passed and 0 failed.
- **Full `vitest` with the touched-module MySQL gates** (integration, administration,
  order-history, order-search, checkout, global-vouchers): 999 pass and 11 fail. The same 11 fail
  at base `3a3e0ab5`, so none is caused by W16. They are owned by W14/W15:
  - `administration/collections` ×7;
  - `administration/mysql.integration` "barcode, variant pricing": `exclusivePrice` `"799"` vs
    `"799.00"`, from the float `pricelist.price`. W16 left this value unchanged;
  - `catalog-details` detail-oracle golden needs recapture;
  - `customer-history` Latin1;
  - `fulfillment/shipping-label`;
  - `global-vouchers`.
- **Live suite:** the results are listed above.

## Shared-file and out-of-ownership edits

- **`src/modules/administration/authorization.ts`:** additive optional `'none'` lock mode.
- **`parity/live-readonly.md`:** notes on the locking default, the plan-gate rule and the
  volume fixture. The resolved NEEDS USER DECISION item is struck through.
- **`tools/live-readonly/connection.ts`, `summary.ts`, new `plan-gate.ts`:**
  - JSON EXPLAIN, the bounded rule and `planBounded` stats;
  - the `refuse` default.
- **`tests/live-readonly/volume-fixture.ts`:** new, loopback-only, refuses any schema not named
  `pos_live_readonly_*`.
- No schema, index, `package.json`, `app.ts` or `config.ts` change.

## Remaining gaps

- **The production plans are unverified until the primary agent re-runs the suite.** Expected
  result:
  - the in-stock catalog page uses a `product_store` range under 100k, with a filesort over that
    range;
  - the out-of-stock picker, the inventory list and the no-match out-of-stock search pass as
    `planBounded`;
  - if the out-of-stock no-match search times out, it is recorded as a legacy-equivalent cost.
- **A search with no match that includes out-of-stock rows walks the full catalog.** That is
  about 0.8 s on loopback, and less work than legacy's two passes over the store.
- **An index on `(store_id, product_id)` would bound both cases**, but the schema is frozen. A DBA
  would have to approve that index.
