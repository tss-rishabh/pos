# W16: query performance and locking reads

Branch `w16/query-perf`, from integration head `3a3e0ab5`. Every check below ran on a loopback
MySQL 8.4.11 server only. Nothing was run against production. The primary agent re-runs the live
suite against production.

## Diagnosis of the plan-gate skips

The production evidence (`evidence/live-readonly-2026-11-19.json`) skipped
`catalog-product-barcode`, `checkout-quote-inputs` and `inventory-list` with
`RO_PLAN_ROWS products range 181046`.

- **The sampling query is not the cause.** It passed with 8 statements.
- **The cause is the rewrite's own app queries:**
  - **`catalogService.products`** forced the plan with `JOIN_ORDER(products, product_store)` and
    `FORCE INDEX (PRIMARY)` on `products`, so the plan was a `products` PK range from `id > after`.
  - **`inventoryService.list`** had no hint. On production the optimizer chose the same PK range,
    through its ORDER BY … LIMIT heuristic.
- **The cost of that plan grows with the catalog, not the store.** It returns quickly when a store
  stocks many low ids. A search with no match, a sparse store or a deep cursor scans the whole
  `products` table.
- **The first statement of each path was rejected.** In `checkout-quote-inputs`, that statement
  is the counter product page.

**Reproduced on loopback.** `tests/live-readonly/volume-fixture.ts` adds about 360k synthetic
`products` (60k parents and 300k variants) and about 22k `product_store` rows per store for 40
stores. With the pre-W16 code, the plan gate rejected catalog and checkout with `products range
175685`.

**Inventory on loopback.** Here the optimizer happened to choose `product_store.store_id`, so this
path ran on loopback; on production it chose the PK range. The new code removes that choice with
a hint.

## Queries changed

Both queries now choose the page of product ids first, in a derived table, using a store index.
They then read the columns and the per-row scalar subqueries (first GTIN, membership price) for
the page rows only. It is still one statement, so all of it is one consistent read.

Before the change, MySQL evaluated those select-list subqueries for every candidate row before the
sort. EXPLAIN ANALYZE showed the "Stream results" step over about 22k rows. That was the only
N+1-like pattern found.

### 1. Counter product page, picker and barcode (`src/modules/catalog.ts` `products`)

**Legacy reference:**
- `AjaxOrderProductsListView` (`core/datatables/store_products_datatable.py:186-293`), which
  filters `ps_product__store`, orders by `id` and runs a `count()` on every request.
- The barcode lookup `ProductBarcode.objects.filter(gtin=barcode).first()`
  (`order/views.py:1720`), which is a point lookup on `gtin`.

**The new plan:**
- **Inner page.**
  - It reads `product_store FORCE INDEX (idx_store_id_stock_is_avail_is_del)`: a range on
    `(store_id, stock > 0)`, or a ref on `store_id` when out-of-stock rows are included.
  - It joins `products` by `eq_ref`.
  - It sorts by id and applies `LIMIT n+1`.
- **Exact barcode.** It reads `products_gs1 FORCE INDEX (gtin)` by `ref`, then joins `products`
  `eq_ref` and `product_store` `eq_ref` through `uq_product_store`. `GROUP BY products.id` keeps
  EXISTS semantics when one product has duplicate GTIN rows.
- **Simplification.** The parent-eligibility branch is `OR stock > 0`, so it is always true when
  the page already requires `stock > 0`. The in-stock page therefore drops that branch and its
  parent join. It stays when out-of-stock rows are included.

**Proof:**
- `tests/catalog/products-plan-orm.mysql.test.ts` (gate `MYSQL_INTEGRATION_URL`) runs the former
  statement verbatim as the oracle.
- It compares the whole `Page` with `toStrictEqual`: values, types, order, cursors, holds and
  storage.
- The inputs cover 3 stores × in/out-of-stock × 9 searches × 6 cursor/limit pairs.
- It also covers 7 exact barcodes: shared, alternate, other-store-only, deleted parent and
  missing.
- It walks every page and checks the walk equals the single-page result.
- It includes deleted and orphan parents, empty names, configurable leaves, `is_avail`/`is_del`
  rows, negative stock and multiple price-list locations.
- 3/3 pass.

### 2. Store inventory list (`src/modules/administration/inventory.ts` `list`)

The page is the same derived page: `product_store` on the index, then `products` `eq_ref`. The
outer query then joins `products` and `product_store` (`uq_product_store`) and reads the first
GTIN.

**Proof:** the existing W11 oracle, `tests/administration/inventory-list-orm.mysql.test.ts`. It
runs the former statement verbatim with a `toStrictEqual` page matrix, and passes.

### EXPLAIN on the loopback snapshot schema plus the volume fixture

| query | before: driving access, est. rows | after: driving access, est. rows | actual before → after |
|---|---|---|---|
| catalog, in-stock first page | `products` range PRIMARY, **175,685** | derived: `product_store` range `idx_store_id_stock_is_avail_is_del`, 26,320; then `products` eq_ref | 57 → 125 ms |
| catalog, including out-of-stock (checkout) | `products` range PRIMARY, **175,685** | `product_store` ref `idx_store_id_stock_is_avail_is_del`, 46,688 | 52 → 205 ms |
| catalog, search with no match | `products` range PRIMARY, 175,685 | as the in-stock row | 417 → 103 ms |
| catalog, deep cursor | `products` range PRIMARY | as the in-stock row | 2.6 → 114 ms |
| catalog, exact barcode | `products_gs1` ref `gtin`, 1 (semijoin) | `products_gs1` ref `gtin`, 1 (explicit and hinted) → `products` eq_ref → `product_store` eq_ref `uq_product_store` | 0.08 → 0.14 ms |
| inventory list | production: `products` range, 181,046. Loopback: `product_store` ref `store_id`, 43,040, with the subquery evaluated for all rows | `product_store` ref `idx_store_id_stock_is_avail_is_del`, 46,688 → `products` eq_ref (covering) | 262 → 180 ms |

In every new plan the outer query reads only the page rows (≤ n+1): `products`, `product_store` and
`catalog_parent` by `eq_ref`, plus the two dependent subqueries by `ref`.

**Trade-off, recorded honestly.** The cost of each page is now bounded by the store's
`product_store` rows instead of by catalog density. It is predictable and passes the plan gate.
However, a dense first page or a deep cursor is slower on loopback than the early-terminating PK
scan was. No index has a `(store_id, product_id)` prefix, and the schema is frozen, so the PK scan
cannot be both bounded and early-terminating.

Legacy is no cheaper: it ran a `count()` over the same store rows on every request.

**Risk for the production run.** If a store has more than 100k `product_store` rows in the index
estimate, the plan gate will still reject the page. The loopback estimate is 26k–47k for about
22k rows.

## Locking reads

The loopback run before the change matched production: 56 locking reads, 12 of them `FOR UPDATE`.
After the change there are **0**. All 16 paths pass with `POS_PROD_RO_LOCKING_READS=refuse`, on both
the plain fixture and the volume fixture. This makes the "NEEDS USER DECISION: downgrade versus
refuse" item in `live-readonly.md` moot. Refuse can become the default.

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
- **Catalog:** hold and storage are already batched.

The only per-row query pattern was the pre-sort scalar subquery evaluation fixed above.

## Checks (loopback)

- **Static checks:** `tsc` and `eslint` pass. `orm-metadata` passes as part of the full run.
- **Full backend `vitest` without database environment variables:** 156 files passed and 53
  skipped; 728 tests passed and 0 failed.
- **Full `vitest` with the touched-module MySQL gates** (integration, administration,
  order-history, order-search, checkout, global-vouchers): 11 failures. The same 11 fail at base
  `3a3e0ab5`, so none is caused by W16. They are owned by W14/W15:
  - `administration/collections` ×7;
  - `administration/mysql.integration` "barcode, variant pricing": `exclusivePrice` `"799"` vs
    `"799.00"`, from the float `pricelist.price`. W16 left this value unchanged;
  - `catalog-details` detail-oracle golden needs recapture;
  - `customer-history` Latin1;
  - `fulfillment/shipping-label`;
  - `global-vouchers`.
- **Live suite** (82 tests, all 16 paths pass, 0 plan rejections, 0 locks), in all four
  combinations of the plain or volume fixture with the downgrade or refuse mode.

## Shared-file and out-of-ownership edits

- **`src/modules/administration/authorization.ts`:** additive optional `'none'` lock mode.
- **`parity/live-readonly.md`:** a W16 update note on locking reads, and the volume fixture.
- **`tests/live-readonly/volume-fixture.ts`:** new, loopback-only, refuses any schema not named
  `pos_live_readonly_*`.
- No schema, index, `package.json`, `app.ts` or `config.ts` change.

## Remaining gaps

- **Production plan estimates are unverified until the primary agent re-runs the suite.** The
  per-store `product_store` estimate must be ≤ 100k.
- **Picker page latency on dense stores is higher than the early-terminating plan's.** It is
  bounded by store size. Revisit only if production timings require it, for example if the DBA
  approves an index on `(store_id, product_id)`.
