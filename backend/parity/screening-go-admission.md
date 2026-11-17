# Screening confirmation and private import lock assembly

This candidate extends the reviewed Go ordinary-payment overlay; it does not select a production profile or change a protected source repository. Payments remains pinned to `434f3e438d1cb48c64e5723222c6efda506db571`; API-v2 remains `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. `legacy-order-imports/prepare.py` generates the checked patch and manifest, including `screening.go`. An original source archive is required if the sibling checkout has moved to another revision; never update the pins merely to make a check pass.

## Native lock protocol

`beginImportConfirmation` reads a minimal native hint outside the owned transaction: customer, single store/counter mapping, exact screening SKU presence and an optional import binding/original actor. It grants no authority. A held import must already have a verified private confirmation capability with that exact scope. An invalid, missing or mismatched capability cannot start financial work.

For every private import, the transaction takes shared original actor/epoch locks, then Store, original financial operation, global customer and finally Order. Ordinary screening confirmations take Store and global customer before Order. Each selected path owns READ COMMITTED; ordinary unbound non-screening confirmation retains its existing RR transaction. The later native current Order/mapping/binding/SKU recheck rejects changed hints rather than acquiring another customer's locks after Order. No skip IDs or lock identities come from a browser.

The existing fresh actor/store/counter/contact, customer active/block/disabled, ordinary projection, membership, consent, voucher, wallet and stock checks remain mandatory. The private capability is checked again immediately before original Apply, after stock/provenance waits, and before the new import confirmation receipt. A late expiry or SQL/proof failure rolls back the entire source transaction. An uncertain caller retains its original operation and reads original proof; it does not redispatch, generate a nonce or collect money again.

Native count/projection reads occur under the global customer lock and take no foreign Order or marker/reservation range locks. READ COMMITTED also avoids absent control-row next-key gaps between different customers. The real source functions run inside the same transaction; no HTTP/provider call occurs under these locks.

## Exact source rows and quota

The count preserves the original join and predicates:

```sql
SELECT STRAIGHT_JOIN COUNT(*)
FROM spiderman_screening_orders s FORCE INDEX (idx_user_id)
JOIN orders o FORCE INDEX (PRIMARY) ON o.id=s.order_id
JOIN has_products hp FORCE INDEX (PRIMARY) ON hp.id=s.has_product_id
WHERE s.user_id=? AND hp.prod_id=390238
  AND o.order_status NOT IN (0,17)
```

Duplicate marker rows count independently. NULL,0,17 do not count; cancelled4 and returned6 still count. There is no payment/store/order-owner/HP-order-owner predicate added to historical counting. Quantity mode can have one HP with qty2 and one marker; unit mode has two HPs/markers. A later qty1 order after a quantity-mode qty2 order can therefore reach two counted rows while representing three units: this is recorded source behavior, not replaced with SUM(qty).

The current new order must have exact native customer/store/counter, SKU390238, sub-product0, positive quantity at most2, and precisely one customer-owned marker per screening HP. Its immutable signed reservation, if imported, must bind the original operation/plan/request/authority/source hashes, mode, quantity, HP IDs and marker IDs. The source order receipt must match its retained HMAC. All required source fields and hashes are strict; missing/unqualified proof is refused before Apply.

Unresolved RESERVED states contribute markerRows. A BOUND state contributes them only while its native order is excluded from the source count. COUNTED state is never invented by Go. Before and after original Apply the candidate checks all bounded customer reservations and exact native projections, without decrementing quota, making markers, releasing another operation or mutating reservation history. Go leaves the original BOUND state unchanged and count-covered. Node alone moves it to COUNTED after immutable financial completion. A completed imported proof replay validates the retained financial seal and the reservation's exact screening-completion reference; archival of its original operator cannot create another payment or erase that receipt.

`spiderman_screening_orders` metadata was independently verified read-only in commit `34b2c65`, artifact `evidence/mysql-screening-schema.json`: INT auto-increment PK; BIGINT order/HP/user IDs; TIMESTAMP NOT NULL defaults, including updated_at ON UPDATE; actual `idx_user_id`, `idx_order_id`, `idx_has_product_id` indexes. The candidate forces the relevant scoped indexes. Missing required indexes fail closed. No new legacy-table DDL is required or run by this slice.

## Explicit selection and remaining work

The additional Go selection values are:

```text
POS_LEGACY_IMPORT_SCREENING_CONTRACT=pos-csv-screening-2960-v1
POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT=pos-screening-schema-v1
POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT=pos-screening-all-writers-v1
```

They require the existing independent `POS_LEGACY_IMPORT_PROOF_KEY`, peer-owned reservation schema/lifecycle and source wrapper, current native authority and the reviewed Go overlay. `POS_LEGACY_IMPORT_FINANCIAL_PROOF_KEY` remains distinct and is used only for retained completed-import proof. There are no new request headers, public inputs or automatic migrations. Root must keep all three selection flags blank until joint qualification.

The ordinary public PosOrder/status writers still need their concrete customer-first assembly and admission guard. That remains a **code task**, separately authorized after this bounded commit. The retained membership-cache consumer's companion [ordering fix](membership-cache-locks.md) is implemented and tested separately. This Go/Receiver candidate does not claim unpatched public writers participate. The Node ticket cancellation refusal preserves the source non-cancellable/non-refundable intent; returning/cancelling a ticket never releases quota by interpreting a refund flag. Real deployment, production schema/procedure/provider and all-writer acceptance remain unperformed.

## Scoped evidence

```sh
sh compatibility/upstream/legacy-order-imports/run-go-tests.sh
sh compatibility/upstream/legacy-order-imports/run-membership-tests.sh
```

The first passes21 top-level Go tests (53 with named subcases), copying the pinned Go package, applying the generated overlay and executing original source SQL against disposable MySQL8.4 with Go1.25.4 race detection. Native cases cover exact COUNT predicates/duplicates, both HP modes, original private and ordinary confirmations, marker credits, stale store/customer/ticket hints in both directions, a fresh cross-store customer wait, non-ticket wallet cancellation holding its own Order, a different-customer marker insert, both customers reaching original Apply before either proof insert, post-Apply corruption rollback,20 concurrent original replays, retained completion after archive, expiry during stock wait and absent proof/index/selection refusal. No retry hides a lock inversion. The second passes all eight existing Python→Go→Node membership staging/activation/cancellation profiles on this overlay, including new/upgrade/free/history-backed membership, rollback,20 callers and Shopify remaining pending. It uses `POS_LEGACY_IMPORT_SOURCE_ROOT` to select the original pinned archive in the fixture; production membership arithmetic/eligibility stays unchanged. It is a component bridge, not live-provider acceptance or a concurrent cache-consumer qualification.
