# CSV membership source profile

This candidate extends the private CSV receiver. It does not activate production flags, change protected repositories, backfill an old entitlement, alter collected tender, or give Shopify a paid receipt. Base API-v2 is `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`; payments is `434f3e438d1cb48c64e5723222c6efda506db571`. `compatibility/upstream/legacy-order-imports/manifest.json` pins the source files, ordinary producer and generated Go overlay.

The actual source paths are API-v2 `controllers/OrderController.py:11135` (PosOrder staging), `controllers/user/userDal.py:33` (eight membership writers), `controllers/CartController.py:833` and `controllers/cart/Cart.py:578` (automatic membership). The original payment activation is `juspay/model.go:2356`. Web `helpers/helpers.py:1862` invokes `EmCheckView` after cash completion; the API handler is `OrderController.py:9690`.

| Source case | Private source result | Subsequent behavior |
| --- | --- | --- |
| New member, method14 | Original setters, inactive EAV, signed STAGED v2 provenance | Original Go activates; native proof and revision commit together |
| Upgrade, method14 | Original setters extend the original expiry and retain the exact before-state | Original Go extends again; preserve the literal source double extension |
| Automatic free member | Original AddFreeMembership adds exactly one zero-price SKU | Explicit extra HP manifest; same staging/activation as a new member |
| New/upgrade/free, Shopify15 | Original setters and signed STAGED v2 provenance; payment1/order1 | No ordinary Go confirmation, paid receipt or invented activation |

The upgrade vector starts with a valid expiry `2030-01-01T00:00:00`. Literal API-v2 staging adds365 days, producing2031; literal Go adds365 again, producing `2032-01-01T00:00:00.000000`. Cancellation's existing typed producer restores the exact original2030 entitlement, value/active flags and native timestamp epochs. This slice does not select an alternative upgrade policy.

A plain anonymous import can retain its existing empty email. Actual membership with no bound email is refused before staging; source-generated temporary-email enrollment needs a separate contact-authority transition and is not silently enabled.

The source cart rejects adding a second membership SKU (`CartController.py:301`); the profile retains a single member quantity1. It rejects unrequested products, changed original lines, a replacement paid-member line, vouchers, complementary products, screening and other unqualified benefits. Current stock for a source-added free membership is locked before order writes. Every original requested quantity and price remains mandatory. The unchanged tender guard refuses a calculation/tender mismatch before order staging; the approved manager-correction workflow is a separate coordinator feature.

## Atomic producer and recovery

`membership_profile.py` compiles the original eight setters and actual PosOrder staging block with the reviewed ordinary membership producer. Only the private stage domain is widened: method15 must have its original payment1/order1; methods3/14 retain0/0. The producer uses fresh customer/email identity, native collation duplicate checks, verified supporting indexes/triggers, current EAV and monotonic revision. Existing provenance is reused only under its exact native proof; no historical snapshot is invented.

Original nested commits become flushes inside the receiver's existing outer writer transaction. Order/HP/refunds, the normal source receipt, held order binding, staged membership provenance, the additional membership receipt and encrypted source effects commit together. A late receipt failure rolls back the literal setters and their revision increments. Once-only operation/stage locks and original receipt reads remain unchanged.

The separate `membership` source receipt binds actor, the original authority HMAC, operation/request/plan/namespace, order/customer/store/counter, source commit, method, native header/line hashes, exact member HPs, explicit added HPs, and the original independently signed STAGED v2 provenance. The ordinary source receipt remains strict and unchanged. All source member HPs must be named; automatic additions must be the configured free SKU, quantity1, native price0, and absent from the original plan. Equal cart quantities alone are not evidence.

The Go import overlay checks both receipt signatures and original context before Apply. It accepts an activated record only for immutable confirmation replay; the ordinary proof verifier still decides whether replay is valid and never invokes Apply twice. Missing/changed membership descriptors and a changed-and-restored native EAV revision cannot authorize activation. Shopify is rejected before Apply by the existing method guard.

`EmCheckView` only repairs inactive/missing new-member EAV. An actual writer-confirmed method14 activation already has active1 and therefore makes the literal handler a no-op, including a backdated order. The source vector also records its inactive branch's order-date argument. The private profile does not dispatch the unbound legacy HTTP repair against a potentially lagged reader; its state is already proved in the writer transaction. Pending Shopify does not run cash completion or this repair.

## Cache effect

The original setter invalidations are deferred rather than executed at nested flush. Only operation UUID and membership receipt hash enter a new static `membership-cache` intent in the existing AES-GCM encrypted source effects journal. The callback/session/cache key/email are never serialized. The private consumer reconstructs a scoped session, locks Order→customer→provenance→receipt, verifies retained identity/proofs, commits a once-only `member-cache` claim, then invokes original `cache.region_invalidate(get_exclusive_token, None, 'exclusive_user', session, userId, email)`. It records completed/uncertain separately; a previous processing/uncertain claim cannot resend automatically.

Broker acceptance means durable queue acceptance. It is not proof of downstream invalidation or cache coherence: original Beaker session-key behavior, other clients and cache repopulation remain reasons to require the independently reviewed fresh-membership reader. No cache callback can roll a committed sale back. The dedicated consumer closes original logging and uses static errors without exception chains; it never logs cache keys, contacts or payloads.

The runtime registers `pos_import_invalidate_membership`. Start a separate approved consumer with the same pinned source/runtime/TLS writer configuration:

```sh
python membership_consumer.py worker --logfile=/dev/null --without-gossip --without-mingle --without-heartbeat -Q '<approved-private-queue>'
```

No consumer is started by tests or application registration. The source Celery app must have publisher confirms and the configured queue must pass the existing durable/non-auto-delete routing checks. A task crash after its claim remains uncertain rather than being automatically retried.

## Qualified historical eligibility

The `>2000` branch executes the exact original short circuit without reading orders. A cart with no ordinary items has the same observable removal in either source history branch, so it need not fetch irrelevant history. Other cases require the typed `CsvMembershipHistoryPort` (`membership-profile/history.ts`) / `QualifiedHistoryPort` (`membership_history.py`). Missing provider/proof returns `ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED`; it never substitutes empty history or falls back to historical MySQL.

The port receives `{contract,operationId,requestHash,planHash,customerId,asOf,cutoff}`; cutoff is the original source's strict45-day boundary at its current execution clock, not the CSV's backdated created_at. Its signed result contains exactly that scope, `reader:'bigquery'`, complete immutable generation, fetchedAt, last delivered order and recent delivered orders with exact HP IDs/prod_id/is_exclusive_order. Both presence and absence need publication completeness. `source-qualified-history` receipts retain generation, asOf/cutoff, fetchedAt and proof hash. Keys are purpose-scoped, proof age is bounded60seconds, payload1MB, total HP rows20k; excessive results are refused, not truncated. Tied latest dates or mixed ordinary HP exclusive flags are review-required because the source query has no determining ORDER BY for those choices.

The literal original `check_criteria` still executes, through an adapter for its three exact SELECT shapes. It preserves the surprising inversion: ordinary HP `is_exclusive_order=1` sets `as_exclusive=False` and can qualify; flag0 can refuse. Tests cover delivered DCC older than45 days, recent non-DCC, missing history, membership-only orders, mixed flags, large exact IDs and malformed/stale/other-customer proofs. No new eligibility formula is introduced.

**Code integration remaining:** the production BigQuery publication/provider and its authenticated bridge into `SourceRuntime(source_root,runtime_root,membership_history=port)` must be supplied. This is not merely a deployment flag. The evaluator, proof codec, typed port and native history-backed profile are executable; the actual warehouse reader is absent in this slice. Raw per-table CDC watermarks are not a complete shared publication and cannot satisfy this port.

## Root integration hooks and selection

No new migration is required. Reuse the existing financial source-receipt/effects tables and membership revision/provenance migration plus the separately reviewed native all-writer triggers/indexes. Missing state/fence refuses work. Legacy trigger DDL is not an automatic rewrite migration.

- Import `assertCsvMembershipProfile` from `src/modules/legacy-order-imports/membership-profile/native.ts`. Call inside the writer transaction with `{state,plan,order,phase:'staged'|'settled'}` and `{contract,sourceProofKey,membershipProofKey,freshReaderContract,productIds,freeProductId}`. It returns `{receipt,expectedQuantities}` or null for a genuinely nonmember order. Before Go use staged; after confirmed method14 activation use settled; method15 remains STAGED in both phases. Do not call the mutable entitlement checker for historical completed reads after legitimate later changes.
- Use its verified expectedQuantities at the exact Node financial manifest check, without mutating the original plan. Recheck after confirmation/at settlement. Preserve the full independent descriptor or its sealed source-receipt reference in completion evidence. The current broad core intentionally still rejects extra unqualified rows until this hook is composed.
- Extend the strict publication job kind with `membership-cache`. Durable broker acceptance and the separate retained cache outcome have distinct meanings.
- Profile selection requires `POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT=pos-legacy-import-membership-v1`, `POS_MEMBERSHIP_FRESH_READER_CONTRACT=pos-membership-fresh-reader-v1`, existing independent membership proof key/native fence/product IDs, and matching real source/Go membership settings. `POS_LEGACY_IMPORT_MEMBERSHIP_CACHE_QUEUE` is a reviewed private durable queue. History uses separate `POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY`; no provider is enabled by defining a key alone.
- Keep the profile unselected until the real source worker, Go overlay, all cooperating writers/native fence, Node hook, fresh readers, stock contract and broker are jointly accepted. No old membership/funding backfill is fabricated. Screening early-lock assembly is a separate commit and remains excluded here.

## Reproducible scoped evidence

From `backend`, with existing locked dependencies and synthetic/local data only:

```sh
node node_modules/typescript/bin/tsc -p tools/legacy-import-membership/tsconfig.json
node node_modules/vitest/vitest.mjs run tests/legacy-import-membership
compatibility/upstream/offline-cash-pricing/.venv/bin/python -B compatibility/upstream/legacy-order-imports/test_membership_profile.py -v
compatibility/upstream/offline-cash-pricing/.venv/bin/python -B compatibility/upstream/legacy-order-imports/test_membership_history.py -v
sh compatibility/upstream/legacy-order-imports/run-membership-tests.sh
sh compatibility/upstream/legacy-order-imports/run-source-tests.sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test node node_modules/vitest/vitest.mjs run tests/legacy-import-financial/source.mysql.test.ts --maxWorkers=1
sh compatibility/upstream/legacy-order-imports/run-go-tests.sh
```

The cross-language runner copies the Go candidate, uses pinned MySQL8.4 and Go1.25.4 containers, existing offline module caches, and a unique ephemeral loopback port. It executes eight profiles (offline/Shopify ×new/upgrade/current-threshold-free/qualified-history-free), source descriptor rollback and20 callers, actual extracted Go activation and rollback, and Node native entitlement/provenance/cancellation components. It does not boot the original application or call a live source service. Catalog/provider/broker I/O and history publications are synthetic. It proves the producer/activation/cancellation components, not a deployed end-to-end import or BigQuery publication. The separate unchanged full PosOrder native receiver suite verifies plain-profile orchestration; new-profile live HTTP/runtime dependency acceptance remains unclaimed.
