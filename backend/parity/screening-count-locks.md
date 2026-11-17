# Screening current-count and lock strategy

Screening remains unselected. This change replaces joined/range locking counts with a current nonlocking read under an actual customer row lock. [Lifecycle integration](legacy-import-screening-lifecycle.md) still owns operation/receipt conservation; no financial formula, source ownership rule, correction binding or public endpoint is changed.

## Node transaction contract

`financialAdapterProfiles.requiresCurrentReads` aggregates trusted profile requirements and selects the internal `financialTransaction` runner. The mandatory membership-descriptor guard now requires this current runner even when member admission is unselected. The runner configures READ COMMITTED before BEGIN, installs an opaque live transaction witness, propagates it into owned savepoints and clears it on exit. Selected work has **no deadlock/timeout retry**. The lower-level unselected runner retains its prior behavior for callers that do not install these financial profiles.

`lockScreeningCustomer` performs the native users-row FOR UPDATE and records that exact customer in the live witness. Counter and structural helpers require both the witness and the lock; no caller-supplied boolean can mark an existing transaction safe. A raw or already primed RR transaction fails with `ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED`. It is never silently changed after BEGIN, and its old snapshot is never used as a bought-count.

Every selected journal call uses the runner: reservation, dispatch, reconciliation/read, uncertain-outcome retention and ordinary callback transactions. Reservation savepoints inherit the live witness. The common ordered load begins with the actor/epoch shared prefix, then Store, original financial operation, customer and native order/reservation authority. The prefix does not add an active-original-actor requirement to immutable receipt reads; current mutation checks stay in their original places.

The count is a bound Drizzle SQL statement:

```sql
SELECT STRAIGHT_JOIN CAST(COUNT(*) AS CHAR) AS value
FROM spiderman_screening_orders s FORCE INDEX (idx_user_id)
JOIN orders o FORCE INDEX (PRIMARY) ON o.id=s.order_id
JOIN has_products hp FORCE INDEX (PRIMARY) ON hp.id=s.has_product_id
WHERE s.user_id=? AND hp.prod_id=?
  AND o.order_status NOT IN (0,17)
```

There is no FOR SHARE/UPDATE in this count. Marker-first customer indexing prevents a broad Order-driven eligibility scan. Non-ticket wallet cancellation can hold an unrelated Order while waiting for the same customer; the counter does not wait for that Order. Empty marker reads do not gap-lock another customer's inserts.

The original count/multiplicity is unchanged: duplicate markers count separately, quantity mode's two-ticket HP contributes one marker, cancelled/returned statuses remain included, 0/17/NULL are excluded, and no additional customer/order/HP/store ownership predicate is invented. New candidate order ownership is separately checked by its sealed projection. Missing indexes/schema/query failures are explicit errors, never zero purchases.

Marker, store-mapping, HP and all-customer reservation projections are nonlocking reads under the witnessed customer. Exact target Order PK and known reservation PK authority remain locked. Marker reads use idx_order_id and customer reservation reads use ix_import_screening_customer, avoiding hidden global range scans. All cooperating screening mutation writers must hold that customer before altering the predicate's status/marker structure.

## Private source counterpart

The wrapper requires `screening_transaction.current(session,cap)`. The independently owned Receiver prelude authenticates the capability, owns a new transaction, takes actor/epoch/Store authority, observes the actual customer FOR UPDATE and issues that opaque witness. A reused/primed session or pre-customer consistent/native order read is rejected. Source count and range projections take no joined/gap locks; count is the first consistent native read after the exact customer lock. The literal PosOrder still creates the original marker rows.

Fresh RR alone does not eliminate missing control-receipt/projection gap locks. The independently owned source helper now selects per-connection READ COMMITTED before any database work (source dependency 8403f0b after fdb6b5f), restoring prior pooled isolation on release. Our actual two-customer/two-store literal PosOrder test requires both source bodies to reach their barrier before either source receipt commits, then verifies two completed receipts and BOUND reservations without retries. The Go owner supplies the separate selected-Go confirmation/control-proof race. Do not enable contracts on a merely fresh RR prelude or infer all-writer qualification from this slice. No SQL lock may cross a provider call; unknown outcomes retain original operation/receipt evidence.

## Verified physical schema

Root's READ ONLY metadata snapshot is `evidence/mysql-screening-schema.json` (commit 34b2c65). No application rows were read. Physical columns are id INT auto PK; order_id/has_product_id/user_id BIGINT NOT NULL; created_at/updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, with updated_at ON UPDATE CURRENT_TIMESTAMP. This differs from the source model's nullable DateTime declaration.

Existing BTREE indexes are PRIMARY(id), idx_user_id(user_id), idx_order_id(order_id), idx_has_product_id(has_product_id). Orders/HP PK metadata is saved too. Fixtures recreate those actual types/defaults/indexes without weakening SQL mode. The two-source race additionally recreates the already captured nonunique users.email and HP/order-store order indexes plus the unique product_store(product_id,store_id) key; the generic fixture intentionally omits secondary indexes and is not itself the production query plan. No guessed covering-index requirement or legacy DDL is introduced.

## Evidence and remaining boundaries

The 46 focused checks cover stale RR refusal and subsequent fresh RC statements, exact source/native count vectors, SQL NULL exclusion, actual EXPLAIN customer→Order PK→HP PK plan, different-customer empty-range inserts, unrelated wallet cancellation/customer waiting, no hidden retry, post-dispatch actor/epoch/customer revocation, rollback, source receipt/financial proof recovery and literal source creation in both line modes. A two-customer/two-store source fixture requires both literal bodies to reach their pre-receipt barrier before either can commit, then checks both complete without retries. Source/Go owner supplies additional transaction-witness/control-proof and actual Go confirmation races.

All-writer seams remain explicit deployment gates: ordinary API-v2/cart screening admission and every legacy payment/status/cancellation/marker writer must participate in the same customer strategy or exclude the SKU. Ticket cancellation/refund must keep the source's non-cancellable fence. Historical malformed marker joins are not silently repaired or omitted; activation needs the separately scoped conservation/legacy-writer qualification. Metadata, synthetic races and a selected local contract are not claims of deployed acceptance or absence of legacy data anomalies.

Run the owned focused and regression Vitest configurations from `tests/legacy-import-screening` with the guarded localhost `CHECKOUT_MYSQL_TEST_URL`. No live data/schema, provider, message or source repository is modified.

This checkpoint passed all 46 focused checks, 19 existing non-source financial/approval/runtime regressions, strict TypeScript and owned ESLint. The eight existing financial-source regression cases outside this slice hardcode the sibling source path; that repository has moved to c6bcd2e. Those eight are not a passing claim at this checkpoint. The 46 screening checks instead executed the required immutable 2960 Python archive through `SCREENING_SOURCE_ROOT`, retaining all controller/helper/model/cart hash checks. Root is supplying that same immutable baseline to the existing general source fixtures.
