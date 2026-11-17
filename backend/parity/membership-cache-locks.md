# Retained membership cache consumer ordering

The private import cache consumer previously locked Order→customer. A cooperating Go original confirmation replay now takes Store→operation→customer→Order; the old consumer could invert those locks. `membership_cache.invalidate` now uses the same customer-first native ordering, without changing membership staging, activation, expiry, cancellation restoration or Redis callback semantics.

The worker first reads a bounded immutable membership receipt in a separate short session. It verifies its source HMAC and exact operation/request/plan/customer/operator/store/counter/namespace before any receipt-derived lock hint is used. That session closes before a new owned READ COMMITTED transaction begins. Its internal `retained_scope` is only a lock witness, not a new financial capability, customer JWT or date approval.

The owned transaction takes shared original actor/epoch, Store, original financial operation, customer, Order, provenance and source receipt. After waiting, it verifies native operation columns, exact retained scope, original authority HMAC, current Order ownership and unchanged signed membership receipt. It marks the same actual customer lock through the opaque owned-transaction witness. Changed hints fail before a cache claim or Redis call; it never locks a newly discovered customer after Order.

The original operator/store may be archived. This worker has only the authority to finish the original sealed cache effect; it cannot quote, create an order, change a wallet, activate membership or mint fresh access. Native customer/email/provenance checks remain mandatory, and historical snapshots are never fabricated. A current scope mismatch or missing original operation/proof remains a reconciliation failure.

Only the existing `member-cache` claim is inserted. It commits before original Redis invalidation, and outcome metadata commits separately. A pending/processing/uncertain claim never automatically dispatches again. A known completed receipt replay returns without another callback. Source broker acceptance remains distinct from Redis completion/cache coherence, so the independently qualified fresh-membership reader is still required.

No new migration, source key, queue, request field or app registrar is needed. The existing static task and encrypted effect journal remain unchanged. The compatibility manifest fingerprints the updated consumer. Root should include the new scoped runner:

```sh
POS_LEGACY_IMPORT_SOURCE_ROOT='<original2960-source-archive>' \
  sh compatibility/upstream/legacy-order-imports/run-cache-order-tests.sh
```

The runner uses existing locked Python dependencies and offline Go caches, pinned disposable MySQL8.4/Go1.25.4, a unique network and an ephemeral loopback port. It executes original source membership staging, actual Go activation and then a concurrent original Go confirmation replay against the real cache consumer. At the precise boundary before the consumer locks Order, native NOWAIT probes prove Store/operation/customer are already held while Order is free. Go is observed waiting on Store; both complete with one invalidation and unchanged financial/native entitlement evidence.

Further native scenarios change plan/store/customer after the verified hint, inject late claim SQL failure, archive the original actor/store, race20 workers while the callback is in flight, and lose the Redis outcome. No retries hide a lock inversion or repeat a cache effect. All scenario groups pass, the eight existing Python→Go→Node membership profiles pass with the new consumer, and nine private protocol/privacy checks pass. Redis/provider I/O is synthetic; no source service or production database is called.

The public PosOrder/status all-writer guard remains a separate code slice. Source repositories remain read-only and no production selection or deployment has occurred.
