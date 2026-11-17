# Original Go consumption during CSV import recovery

The method 14 settled verifier now treats original authenticated consumption as a past fact, rather than requesting another current coupon eligibility decision. The staged path and Shopify method 15 retain the current coupon-control/assignment checks because neither has an original Go consumption event to establish that fact.

Before settlement, the combined financial profile independently authenticates the source confirmation receipt, exact original confirmation nonce and confirmed stage. The original Go consumption receipt must have its own valid purpose HMAC and match that exact confirmation hash, the staged coupon receipt hash, original actor/customer/store/counter/order, plan/request/authority hashes and full source header/line digests. The receipt's assignment IDs are unique and exhaustive; each original before count must match the staged source receipt, with an exact increment of one. Those frozen deltas remain evidence even when another order changes or deletes the current assignment rows.

No mutable paid flag, HTTP status or caller-supplied quantity map grants this authority. The native original coupon log ID/content/status must still match. Native original order/header/HP/refund digests, POS grants, projection and existing correction/approval/membership bindings remain checked by the unchanged financial writer. Source proof keys are required to authenticate first completion; an existing financial completion seal is authenticated with its retained financial key before reading its immutable inner snapshot.

The positive test uses the actual `coupon_bridge_test.go` executable over the existing Go `Confirm` and pinned `sourceApply`, with the `981d944` consumption overlay. The source fixture constructs original HP/POS-selection/refund evidence, while real Node queue, correction review, successor, historical approval, adapter, settlement and common financial seal run against disposable native MySQL. The test never invokes the Python coupon deduction oracle. This is component integration evidence; it is not deployment acceptance of the full private Python Receiver, birthday publication or provider transport.

Thirteen added native cases passed with the 28 existing original-Go cases:

- Original Go confirmation followed by disabled/expired/changed coupon controls, increased counters/allowances, deleted assignment or changed customer birthday completes exactly once. The original sealed increment remains 0→1, cash is 45.00 after explicit correction of the original 104.47 tender, stock moves once, and publication runs once.
- Missing, invalidly signed or copied consumption; missing confirmation/log; changed native refunds, grant or projection retains uncertainty. GET and exact replay create no cash/publication and do not repeat original stock or coupon consumption.
- The final native commit succeeds but its ACK is lost; source key, contact/block, catalog, counters and original source descriptors then change. The already committed financial seal recovers the exact receipt using only retained financial proof authority, with one cash record, one native projection, one coupon log and one publication dispatch.

Run from `backend` with an immutable API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` archive:

```sh
POS_LEGACY_IMPORT_SOURCE_ROOT=/path/to/immutable-api-v2-2960 \
SCREENING_SOURCE_ROOT=/path/to/immutable-api-v2-2960 \
  sh compatibility/upstream/legacy-order-imports/run-coupon-tests.sh \
  tests/legacy-import-benefits/consumed-recovery.mysql.test.ts
```

The existing runner uses existing digest-pinned images, builds only the isolated Go fixture, chooses a random loopback MySQL port and drops its disposable container. Production flags remain blank. No live source data or provider/broker/database writes occur.

Changed current actor/contact authority before new settlement/publication still requires an explicit successor/reference-transfer workflow that is not implemented here. This change does not create that workflow, fabricate a principal or make GET start an unstarted stage. Original proof-key retention is required until first complete sealing; after sealing, current source keys/configuration are unnecessary for immutable recovery.
