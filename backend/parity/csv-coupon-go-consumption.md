# CSV coupon confirmation evidence

This review-only Go overlay records the actual existing source coupon
deduction. It adds no deduction, payment, source application initialization,
provider call or automatic production selection. Protected repositories and
live schemas/data remain unchanged.

The pinned payments source is `434f3e438d1cb48c64e5723222c6efda506db571`.
Its extracted `sourcefixture/source_allocations.go:561–571` increments every
`coupons_users` row matching the customer and coupon, then inserts one active
`order_coupon_log`. Non-user-specific duplicate assignments each increment;
zero matching assignments still produce the source log. API-v2
`2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` stages coupon/HP/refund facts through
the separately qualified benefit profile. Its Python deduction remains an
independent oracle and is never called alongside the real Go deduction.

The new `coupon_consumption.go` hook runs in the existing `Confirm` transaction:

1. After current authority, Order/customer/stock and consent locks, validate the
   original `coupon-benefit` receipt and its source-key HMAC. Bind operation,
   request/plan, actor/authority, isolated namespace, order/customer/store/
   counter, method14 and source hashes. Validate the current native financial
   header, every exact HP/refund allocation, coupon controls and all original
   counter rows. A missing or changed descriptor refuses before Apply.
2. Run the original Apply once. The overlay does not execute an UPDATE or
   INSERT against coupon counters/logs.
3. Capture each actual `before→after=before+1`, unchanged allowance fields,
   native counter hashes and the actual log ID/native hash/status. Recheck the
   frozen header/control/HP evidence. Insert `coupon-consume` alongside the
   original ordinary projection and source confirmation receipt, before their
   existing COMMIT. Any mismatch or late insert failure rolls everything back.

The descriptor is exactly the existing Node `couponActivationSchema`:
`pos-csv-coupon-consumption-v1`, original benefit scope, stagedReceiptHash,
couponId, sourceConfirmationHash, changes and log. The independent existing
`POS_LEGACY_IMPORT_PROOF_KEY` signs
`legacy-order-imports.source.benefit.coupon-consumption.v1`. Map-based
code-point ordering matches Python/Node; struct declaration order is not used.
All native money/FLOAT hashes remain MySQL expressions, never Go arithmetic.

Replay verifies the original consumption HMAC, source confirmation body/HMAC,
exact staged scope/deltas and native original log. It does not reapply source
work or require today's counters to equal the old after values: another
legitimate coupon use may advance them. The Node pre-finalization verifier can
still refuse a changed current counter until its own immutable completion is
sealed; the original deduction and unknown outcome must remain retained.

The existing source method14 confirmation remains payment_status1 /
order_status1. This receipt is not evidence of collected cash or a paid order.
Shopify remains method15/pending and never enters ordinary confirmation or
acquires coupon-consumption/paid proof here.

## Selection and integration

Root may add this blank/unselected Go option:

```
POS_LEGACY_IMPORT_COUPON_CONSUMPTION_CONTRACT=pos-csv-coupon-consumption-v1
```

The option is required for an imported nonzero coupon or a staged coupon
descriptor. Ordinary non-import orders and imports with no coupon retain their
existing behavior. Missing key/receipt/configuration is a refusal, never a
fallback. There is no public request flag or allowed-operation bypass.

`prepare.py` now emits `coupon_consumption.go` and the exact native line hash
constant into the existing payments overlay; its manifest records the code
hash with activated=false. `recordLegacyImportConfirmation` receives the
invocation-local capture and calls the emitter with its actual confirmation
seal. Context capabilities remain immutable across concurrent callers.

No new DDL is required: `coupon-benefit` and `coupon-consume` use the existing
source receipt table/unique(operation_id,kind) key. Root's Node benefit reader
already recognizes the kinds and strict descriptor. Root still owns selected
capsule composition, capability/history/claim plumbing, final financial
completion/publication, environment/verifier wiring and combined deployment
qualification. Regenerate the overlay after merging the independent public
screening writer; preserve its separate origin proof and source guards.

Coupon controls retain the shared lock already acquired by ordinary consent.
The hook never upgrades it to exclusive: different customers may hold shared
coupon controls concurrently. Assignment rows lock in primary-ID order under
the current customer lock and import's owned READ COMMITTED transaction. No
HTTP/history query/broker publication runs under these locks.

## Focused evidence and its limits

```
POS_LEGACY_IMPORT_SOURCE_ROOT=/path/to/immutable-api-v2-2960 \
  sh compatibility/upstream/legacy-order-imports/run-coupon-tests.sh
sh compatibility/upstream/legacy-order-imports/run-go-tests.sh '^TestImport'
npx --offline node@24.22.3 node_modules/typescript/bin/tsc \
  -p tools/legacy-import-coupon-go/tsconfig.json --pretty false
npx --offline node@24.22.3 node_modules/eslint/bin/eslint.js tests/legacy-import-coupon-go
```

The new runner compiles the original Go source fixture using the installed
digest-pinned offline Go image/cache, starts a disposable pinned MySQL8.4
container on a random localhost port, waits for its own initialized timezone
tables, creates random native fixture schemas and removes them/container on
exit. No host SQL-mode/timezone mutation or dependency installation occurs.

Twenty-eight native cases pass (27 together, then the additional precision
case), including both HP line modes, duplicate and
zero assignments, twenty same-operation confirmation contenders, missing/
tampered/configuration/scope/counter evidence, late double deduction/wrong or
missing log/changed header/HP/allowance, final proof-insert rollback, concurrent
current counter changes after a customer wait, shared-lock non-upgrade, exact
replay after another use, exact counters above 2^53, corrupt confirmation/delta
proof, and Shopify refusal.
The existing Go import regressions pass under -race: seven top-level tests,
twenty named cases including subtests. Scoped TypeScript and ESLint pass.

The source bridge reuses pinned actual coupon/wrapper/constructor/grant/refund
components with explicit synthetic catalog/history inputs, then real Go Apply
and the strict Node native verifier. It does not run the fully composed
Receiver/manager-correction workflow or certify historical publication. Its
declared CSV tender differs from the discounted header; the test checks only
the confirmation/benefit boundary and never calls final cash settlement or
manufactures a paid receipt. The user-selected manager-correction policy must
still be enforced before real financial import. No profile gate was weakened
to make these fixtures pass.
