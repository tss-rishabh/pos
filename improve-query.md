# Query improvements and evidence

Investigation uses MySQL 8.0.39, schema `tss`, TLS verification and a read-only
session. No index or schema changes have been executed. Saved query plans and
bounded comparison results are in `backend/evidence/mysql-readonly.json`.

## Customer first-order history: implementation pending final validation

Pinned API-v2 order creation performs three customer-wide, all-time reads:

```sql
SELECT COUNT(id) FROM orders
WHERE user_id = ? AND NOT order_status = 4;
SELECT COUNT(id) AS order_count FROM orders
WHERE user_id = ? AND order_status = 3 AND flag_id = 18;
SELECT COUNT(id) AS order_count FROM orders
WHERE user_id = ? AND order_status = 3 AND flag_id != 18;
```

The replacement in `backend/src/modules/screening-origins/history.ts` reads
one independently published customer/head cohort from BigQuery. It preserves
the literal status/flag predicates, including SQL NULL exclusion, without
adding a paid/date filter or joining order lines. The source replay adds only
the exact newly inserted native order when that row satisfies each original
predicate. This keeps old-order scans outside the interactive MySQL path.

The database-side candidate is
`backend/compatibility/upstream/screening-origins/history-heads.review.sql`,
with the separate security/grant plans in that directory. Its four triggers
advance operational customer revisions and retain change identities in the
same transaction as relevant user/order writes. The source verifies actual
trigger bodies, owners, physical keys and privileges, then fences the final
revision at physical commit. A changed customer head requires a newly qualified
generation; missing evidence never becomes a zero count. The background native
capture requires an existing customer-leading order index and explicit read-only
writer-origin credentials. It exports a bounded customer snapshot; it does not
silently add an index or execute a replica scan during checkout.

All native trigger/definer/grant changes remain review-only and are excluded
from automatic migrations. No such DDL has been executed on the supplied reader.
The standalone bridge bounds concurrent reads, dry-run bytes, execution time and
result size. See [the exact history contract](backend/parity/screening-origin-history.md).
Response parity, query plans and representative performance measurements for
this new path are deferred until implementation is complete, following the
user's work order. Existing evidence elsewhere in this file does not certify
this new path.

## Coupon consumption logs and assignments

The native coupon proof checks retain duplicate detection and exact ID ordering:

```sql
SELECT id FROM order_coupon_log
WHERE order_id = ? ORDER BY id LIMIT 2 FOR UPDATE;
SELECT id FROM coupons_users
WHERE user_id = ? AND c_id = ? ORDER BY id FOR UPDATE;
```

The actual ORM projections also return native digest and allowance fields.
Saved schema metadata shows only a primary key on the log and separate user/coupon
indexes on assignments. Proposed nonunique indexes preserve every response row:

```sql
CREATE INDEX ix_order_coupon_log_order_id
ON order_coupon_log(order_id,id);
CREATE INDEX ix_coupons_users_user_coupon_id
ON coupons_users(user_id,c_id,id);
```

An isolated 20,000-row fixture compares every actual projection field before
and after each index, including IDs above 2^53 and duplicate logs/assignments.
Observed maximum rows visited at one plan node fall from 20,000 to 1 for the
log and 6,659 to 67 for assignments. This establishes local plan/response
evidence, not production latency. No live DDL was executed and neither index
is an automatic rewrite migration. See the
[exact query and qualification scope](backend/parity/csv-benefit-query-improvements.md).

## Rewrite CSV financial close-impact guard

The no-effect verifier must reject any retained close impact for an import
operation. The original rewrite table has only its `id` primary key, so this
bound lookup otherwise scans retained financial history:

```sql
SELECT id FROM pos_rewrite_import_financial_close_impacts
WHERE operation_id = ? LIMIT 1;
```

The forward, rewrite-only migration adds its missing predicate index:

```sql
CREATE INDEX ix_import_financial_close_operation
ON pos_rewrite_import_financial_close_impacts(operation_id);
```

The SELECT, existence predicate and frontend rejection result remain the same;
no guessed close ID replaces the complete operation predicate. The isolated
native fixture compares presence/refusal before and after the index and checks
index eligibility. This is local evidence, without a production latency claim.
The migration is registered after the original table and does not modify its
existing migration checksum or run DDL on the supplied shared reader.

## Historical warehouse parameters and projections

The shared adapter now serializes DATE/DATETIME/TIME/TIMESTAMP parameters with
the pinned SDK's typed wrappers. Plain strings previously became SQL NULL.
TIMESTAMP zero padding is reduced to the API's supported microsecond precision;
real sub-microsecond inputs require an explicit caller boundary decision.
Fourteen local wire/adapter tests and seven live generated-value fields passed.
No source table was queried for this proof. See
[parameter evidence](backend/parity/warehouse-parameters.md).

Actual raw customer-history dry runs estimate 3,217,272,021 and 1,506,392,998
bytes, above the unchanged 1 GB guard. Execution is refused before source reads.
The [row-preserving bucket-partition proposal](backend/parity/customer-history-query-proposals.md)
retains every HP occurrence and store-association count while enabling pruning.
Its DDL is review-only; no live dataset/schema or reader grant was changed.

Historical NPS facts can use the three observed raw tables with bounded current
question/customer/store dimensions on the primary reader. A dry run estimates
577,884,239 bytes. Native indexed email equality preserves the source's accent,
case and PAD SPACE semantics; LOWER cannot substitute for that comparison.
No duplicate email index is needed. Exact comparisons and optional date
partitioning are in the [feedback proposal](backend/parity/feedback-history-query-proposals.md).

## Pending refund contact references

Verified source metadata has no order-leading index on pending alternate-refund
addresses. The current contact update retains the source join and failed/pending
status rules, with a proposed nonunique index for writer review:

```sql
CREATE INDEX ix_contact_refund_order_status_request
ON refund_alternate_payment_details(order_id,status,refund_request_id);
```

The isolated native fixture compares the complete contact-reference effects
against the pinned source helper before and after adding this index, and verifies
that the bound order/status lookup can use it. Recipient and frontend response
semantics remain unchanged. This is index eligibility evidence, without a live
latency claim or live DDL. See the
[query and comparison conditions](backend/parity/customer-contact-query-improvements.md).

## Current customer benefits

The current membership, app flag, balances and active-voucher count are read
with one bound ORM projection. Verified keys are users.id,
user_eav(entity,attribute), unique user_addons.user_id and gift_vouchers.to_id.
Existing indexes support these predicates; no additive live DDL is proposed
without representative plans. Four isolated native cases retain the source
response values and prove current authority/rechecks. The separate source
helpers replay28 membership, wallet and campaign vectors.

Keep the recipient and membership email comparisons as bound parameters.
users.email and user_eav.entity have different collations. A column-to-column
join can change which membership matches an accented email, even when it looks
like an equivalent optimization. The native comparison preserves the source
latin1_swedish_ci behavior. See [customer workspace evidence](backend/parity/customer-workspace.md).

## Local delivery unset exception date

A normal arriving local-delivery order can lack a courier log. The source
finalizers use update_or_create, but the verified table's required
delivery_exception_date has no default and both models omit that field.
The review-only correction is:

```sql
ALTER TABLE hyperlocal_order_log
  MODIFY COLUMN delivery_exception_date DATETIME NULL DEFAULT NULL;
```

This preserves existing rows and dates. A newly unset exception remains SQL
NULL and renders through the exact source formatter's empty branch. Native
fixtures prove the original strict insert failure, the corrected insertion and
unchanged existing values. No zero-date conversion or live equivalence is
claimed. The rewrite verifies the physical schema before dispatching a
missing-log operation; the shared-state migration runner never applies this
source ALTER. See the [proposal and frontend evidence](backend/parity/legacy-fulfillment-query-proposals.md).

## Store catalog pagination

Observed: a catalog projection with `ORDER BY p.id LIMIT 25` uses an intersection
of the single-column `store_id` and `is_del` indexes. The plan estimates about
155,373 store rows and 139,835 joined product rows, then uses a temporary table
and filesort. Both naïve join spellings exceeded the five-second limit. Merely
moving `product_store` before `products` does not fix the plan.

Existing indexes include unique `(product_id,store_id)` and
`(product_id,store_id,is_del)`; the latter's name misleadingly starts with
`idx_store_id`. Neither begins with `(store_id,is_del,product_id)`.

An immediate code-level candidate walks the product primary key in requested
order and performs an exact store lookup through the existing unique index:

```sql
SELECT p.id,p.product,p.price,ps.stock
FROM products p FORCE INDEX(PRIMARY)
STRAIGHT_JOIN product_store ps FORCE INDEX(uq_product_store)
  ON ps.product_id=p.id AND ps.store_id=?
WHERE ps.is_del=0 AND p.product<>''
  AND (p.is_del=0 OR ps.stock>0)
  AND p.id>?
ORDER BY p.id
LIMIT ?;
```

The new ORM endpoint uses the equivalent `JOIN_ORDER` optimizer hint plus index
hints, with keyset pagination. The predicate preserves the archived-but-stocked
SKU rule. Bounded equality of the old and new projection passed for store 1 and
product IDs `(0,10000]`. The saved evidence records the timings and row count.
This is sample query parity, not full product-datatable or full-dataset parity.
The complete ORM projection, search and all page boundaries still need their
own live differential tests.

Candidate DDL for DBA review, only if representative plans justify it:

```sql
CREATE INDEX ix_product_store_store_deleted_product
  ON product_store(store_id,is_del,product_id);
```

Re-run EXPLAIN with real store sizes, empty/sparse stores, search filters and
deep cursors before selecting an unconditional optimizer hint. Hinting products
first can be worse for sparse stores. Adding an index does not change the result
set, but the response still needs validation for sort ties and NULLs. Never add
an index with a misleading existing name without checking its actual columns.

## Full materialization in the legacy product datatable

`core/datatables/products_datatable.py:46` loads and groups the entire match set,
then paginates in Python; the search branch repeats it and interpolates a search
string and sort identifier. The new catalog module uses allowlisted sort
identifiers, bound search/store values, an EXISTS count, and SQL pagination of
IDs before bounded enrichment. Source fixtures preserve the filtered-total
behavior, DISTINCT aggregates, null serialization and page fallbacks. Conflicting
membership-location prices require reconciliation instead of selecting an
arbitrary different value. Full production parity certification remains pending.

A local fixture with 2,000 products, eight stores, 24 categories and two equal
price locations joins 768,000 source rows and transfers 2,000 result rows. The
rewrite enriches 25 product IDs and transfers 26 rows including the count, with
identical first-page response hashes. The final collation-aware replay measured
approximately 2,017–2,078 ms for the source and 10.2–10.6 ms for count plus page.
These are local fixture measurements, not production latency claims. Existing
indexes suffice for this rewrite.

Inventory-audit count queries need a covering product/store/date index where
representative plans justify it:

```sql
CREATE INDEX ix_product_inventory_scope_date ON pos_product_inventory_logs(product_id,store_id,created_at,id);
CREATE INDEX ix_held_inventory_scope_date ON pos_hold_stock_logs(product_id,store_id,created_at,id);
CREATE INDEX ix_storage_inventory_scope_date ON stock_storage_logs(product_id,store_id,created_at,id);
```

The product-audit fixture retained identical counts and pages while reducing
count candidates from 40,000 to 333. Its ID-sorted page continued to use the
existing index; no page speedup is claimed. Held/storage indexes need separate
workload validation. No live DDL was executed. See the
[catalog proposals](backend/parity/catalog-query-improvements.md) and
[measurement artifact](backend/parity/evidence/catalog-details/query-benchmark.json).

## Daily rollups

Do not simplify legacy DSR arithmetic without differential fixtures. The source
deliberately adds approved PG discount back for membership AOV, excludes
exchange orders, and counts surviving forward line statuses. Store-assisted
online and walk-in rows are combined before computing ratios; totals recompute
ratios from summed numerators. Historical queries belong in BigQuery, with a
verified warehouse mapping and CDC watermark, rather than an interactive reader.

## Administration lists and settings

Operator and salesperson lists use bounded keyset queries plus one batched
assignment lookup. Explicit projections omit credential fields. Confirm the
existing indexes on `user_stores(django_user_id)` and
`store_salesperson(salesperson_id)` before adding duplicates.

Location settings retain source uppercase/sorting/duplicate behavior and lock
all matching platform rows before merging additions. This preserves the same
frontend list during concurrent writes. If an equivalent index is absent:

```sql
CREATE INDEX ix_tss_settings_platform_id ON tss_settings(platform,id);
SELECT id,value FROM tss_settings WHERE platform=? ORDER BY id FOR UPDATE;
```

The isolated MySQL suite verifies concurrent additions and duplicate conflicts.
See [administration details](backend/parity/administration-query-improvements.md)
for barcode, price-list and current-day inventory audit constraints.

## Fulfillment business-day predicates and refund joins

Replace `DATE(pending_expires_at)=?` with bound half-open business-day limits:

```sql
WHERE store_id=? AND status='PENDING'
  AND pending_expires_at>=? AND pending_expires_at<?;
```

This returns the same rows for MySQL DATETIME values, including fractional
seconds and NULL exclusion. The local 20,000-row fixture returned identical
250 order IDs; estimated examined rows fell from 2,000 to 250 because the
expiry key part became usable. This is fixture evidence, not measured live
latency improvement. Candidate indexes, only if absent and representative
plans justify them:

```sql
CREATE INDEX ix_eli_store_pending_day
  ON express_line_item(store_id,status,pending_expires_at,order_id);
CREATE INDEX ix_eli_store_accepted_day
  ON express_line_item(store_id,status,accepted_expires_at,order_id);
CREATE INDEX ix_eli_packed_audit
  ON express_order_status_log(order_id,new_status,store_id,changed_at);
CREATE INDEX ix_return_store_day_refund
  ON return_orders(store_id,created_at,order_id,has_product_id);
```

Multi-store cash ledgers join distinct `(store_id,order_id,has_product_id)`
return keys before summing refunds, preserving the source EXISTS semantics
when duplicate return rows exist. Historical opening chains still use BigQuery.
The Glassbox feed retains source MAX refund aggregation with explicit
`ANY_VALUE` projections for strict SQL mode; conflicting tied payment/store
rows remain an unresolved source ambiguity.
See [queries, fixes and parity evidence](backend/parity/fulfillment-query-improvements.md).

## Checkout audit, refund and exchange lookups

The source PG discount audit table has only a primary key, confirmed through
read-only `SHOW COLUMNS`/`SHOW INDEX`. Refund and exchange candidates below
need representative plans and duplicate-index checks before deployment:

```sql
CREATE INDEX ix_refund_order_line_product
  ON amount_to_be_refunded_log(order_id,has_product_id,prod_id,is_refunded,id);
CREATE INDEX ix_return_order_line_product_store
  ON return_orders(order_id,has_product_id,prod_id,store_id,created_at);
CREATE INDEX ix_products_parent_id ON products(parent_prod_id,id);
CREATE INDEX ix_options_product_id ON has_options(prod_id,id);
CREATE INDEX ix_store_invoice ON order_stores(store_id,order_invoice);
CREATE INDEX ix_pg_discount_order ON store_pg_disc_addons(order_id,id);
```

Preserve the exact order/line/SKU refund key, source row ordering, same-store
credit-note proof, last size option in ascending option-ID order, and source
lexicographic invoice maximum. Do not substitute numeric invoice sorting.
The audit index is a candidate for exact order lookups, not an observed live
performance bottleneck. No candidate DDL was executed against the live reader.
See [checkout query conditions](backend/parity/checkout-improve-query.md).

## Scheduled report platform classification

The source counts all matching flag-history rows only to decide whether an
order has flag18. The scheduled adapter uses a bound EXISTS predicate, retaining
zero/one/duplicate flag behavior and the source distinct order set:

```sql
EXISTS (SELECT 1 FROM flag_history f
        WHERE f.order_id=o.id AND f.flag_id=18)
```

Saved read-only metadata shows only single-column indexes, including two on
order_id. Proposed nonunique additive fix, after workload/index review:

```sql
CREATE INDEX ix_flag_history_order_flag
ON tss.flag_history(order_id,flag_id);
```

A local20000-flag/50-order fixture retained the exact response SHA-256 and43 app
orders. EXPLAIN ANALYZE candidate rows fell from1000 to43; this is fixture row
access evidence, without a live latency claim. The original GROUP_CONCAT limit
can silently truncate IDs: groups exceeding100000 bytes now require explicit
reconciliation instead of silently changing the report totals. No live DDL was
executed. Reproduction, duplicate semantics and further proposals are in
[operational report proposals](backend/parity/operational-report-query-improvements.md)
and [the measured fixture](backend/evidence/operational-reports/flag-query.json).

## Offline cash price snapshot

The pinned API-v2 product initializer performs two main catalog reads but then
reads product_store once per displayed variant and SKU. The private offline-cash
pricing projection preserves its source method and price guard while batching
those store-stock lookups. Store/counter validation, products, variants, store
stock, barcode/first-category HSN and all quantity/slab matches require seven
read-only queries in one snapshot. The complete source hydration and 44 FLOAT
slab boundary comparisons pass against isolated MySQL tables generated from
verified metadata. No production latency claim or live schema change is made.

The tax query binds one JSON_TABLE payload and lets MySQL compare each exact
source numeric amount with native FLOAT slab columns. No per-quantity network
round-trip or replacement rounding formula is used. Overlapping slabs fail
closed rather than choosing an unstable first row. Preserve source first HSN
association ordering by has_categories.id and first barcode by products_gs1.id.
Before adding any index, compare representative reader EXPLAIN/selectivity for
product_store(store_id,product_id), has_categories(prod_id,id), and
products_gs1(product_id,id); do not apply redundant indexes automatically.

Evidence and deployment limits: backend/compatibility/upstream/offline-cash-pricing/README.md,
backend/tests/checkout/offline-cash-source-pricing{,.mysql.integration}.test.ts.

## Approved duplicate-SKU refund correction

The user selected corrected per-line refunds. The source UPDATE currently
matches every occurrence of a product in the order, overwriting distinct
per-line allocations. The approved predicate retains the order/product checks
and adds the individual has_products primary key:

```sql
UPDATE has_products
SET amount_to_be_refunded = ?, fraction_value = 0
WHERE order_id = ? AND prod_id = ? AND id = ?;
```

This is an approved correctness change, not a response-identical optimization.
The independent 51-vector comparison retains refund arithmetic, audit rows,
cancellation mapping and other fields; 47 affected per-line values change to
their existing audit allocations. Source allocations that remain negative,
non-cent-exact or inconsistent with the paid total still fail closed. The
rewrite template uses the explicit pinned correction profile; ordinary online
checkout requires upstream rollout and verifies native per-line audit equality
before charging. No live source or data was modified. See
[refund decision and evidence](backend/parity/offline-cash-refund-query.md) and
the separate [legacy unset-event-date schema candidate](backend/compatibility/upstream/offline-cash-import/improve-query.md).

## Financial notification outbox claims

The rewrite's original payment outbox has only its UUID primary key. Its worker
selects the oldest pending producer/engagement/SMS row, excluding claimed and
completed rows. Without a pending-work index, delivery history can be scanned
and sorted on every worker poll:

```sql
SELECT id, kind, order_id
FROM pos_rewrite_payment_outbox
WHERE status = 'pending'
  AND kind IN ('order-kinesis','order-engagement','order-sms')
ORDER BY created_at, id
LIMIT 1 FOR UPDATE SKIP LOCKED;
```

Add the nonunique, ordered-work index through the controlled rewrite migration:

```sql
CREATE INDEX ix_payment_outbox_pending
ON pos_rewrite_payment_outbox(status, created_at, id, kind);
```

The predicate, chronological tie-break and claim locking do not change. The
index alone produces the same selected row/front-end response; kind remains a
residual/covering field so multiple kinds do not change the chronological sort.
`backend/src/modules/checkout/order-messages/migration.sql` and the ORM mapping
record the same index. Isolated MySQL verifies its four-column order, exposes it
as an EXPLAIN candidate and exercises concurrent first claims and frozen
interrupted delivery. This is local plan/behavior evidence, without a live
latency or production schema claim.

Separately, customer SMS now requires writer-paid order evidence before a claim,
and the local adapter validates native projection proof while that claim is
locked. The correlated paid predicate uses the orders primary key:

```sql
EXISTS (SELECT 1 FROM orders o
        WHERE o.id = CAST(pos_rewrite_payment_outbox.order_id AS UNSIGNED)
          AND o.payment_status = 4)
```

This is a deliberate notification correctness guard, not a response-identical
optimization: queued unpaid orders stay pending. No cash is collected, repeated
or removed by notification processing. No live DDL or customer message was used.

## Pending cancellation voucher-ledger locking index

The read-only physical snapshot
`backend/evidence/mysql-global-benefits-schema.json` shows only `PRIMARY(id)`
on `gift_voucher_history`. Pending cancellation must verify the exact original
voucher debit using this bounded, bound-parameter writer query:

```sql
SELECT id,user_id,added_amt,amt_before_update,amt_after_update,platform
FROM gift_voucher_history
WHERE order_id = ? AND gv_id = ?
ORDER BY id LIMIT 1001 FOR UPDATE;
```

Without a selective index, the scan can lock unrelated voucher histories.
The reviewable additive, nonunique fix is:

```sql
CREATE INDEX ix_pos_gv_history_order_voucher
ON gift_voucher_history(order_id,gv_id,id);
```

This changes neither the predicate, duplicate-row eligibility, chronological
ordering nor selected monetary values. The isolated physical-MySQL regression
compares the exact result before/after the index and checks EXPLAIN exposes the
new key. Cancellation verifies a supporting visible index before taking the
ledger locks; it first retains the table metadata lock so a concurrent DROP
cannot invalidate that check. An unavailable index fails before financial
mutation, while zero-benefit and wallet-only cancellation remain available.

The candidate is
`backend/compatibility/upstream/pending-cancellation/voucher-history-index.sql`.
It is deliberately excluded from automatic migrations: production deployment
must review existing indexes and online-DDL behavior. No live DDL, production
row access or live latency claim occurred. Local rollback/replay tests cover
the restoration independently of this response-equivalent index change.

## Recorded payment correction lookups

Correction and repayment checks select payment-outbox jobs by order, kind and
delivery status. The existing pending-worker index begins with status and time,
so it cannot bound every order-only lock/read. The additive rewrite migration
includes:

```sql
ALTER TABLE pos_rewrite_payment_outbox
ADD INDEX ix_payment_outbox_order_state(order_id,kind,status,id);
```

The native fixture compares identical selected rows/frontend values with and
without the index and verifies `ref` access. It retains the worker's pending
index. New cash movement lookups also use store/date and order indexes, and
proofs are read in bounded batches. Details and scoped evidence are in
`backend/compatibility/payment-reversals/improve-query.md`. No live DDL or
production latency measurement was performed; the correction finance contract
remains unselected until its collection/ledger/DSR/publication integration passes.
