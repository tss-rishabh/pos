# Private source coupon and complementary preparation

This slice composes the existing `pos-csv-automatic-coupon-v1` and
`pos-csv-pos-complementary-v1` candidates into the actual private source runtime.
It does not select a live source, deploy review SQL, certify an external
warehouse generation, or consume a coupon a second time. Offline coupon
consumption remains the original qualified Go confirmation; Shopify retains its
separate method15 header/consumption behavior.

## Source and authenticated selection

Source is API-v2 commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. Eligibility
and allocation functions are compiled from the pinned original
`libs/OrderHelper.py`, `libs/helper.py`, `MetaInitializers.py`,
`CouponValidation.py`, `CouponWrapper.py` and `PosFreebieWrapper.py`. The source
Cart/Catalog/Validate/Processing/PosOrder methods remain literal. The original
CSV prices, declared tender and selected products are retained. The approved
per-HP refund patch remains selected; its bytes are unchanged.

The native operation's optional, nondefault `benefitContracts` marker is copied
into the order-only capability and preview. It is compared with current native
state and the installed source profiles. Current environment flags cannot add
benefits to an unmarked predecessor. Later publication/confirmation capabilities
keep their existing fourteen-field ABI; their request hash still binds the saved
marker. Membership additions and paid-to-free replacements come only from the
existing invocation-local membership context, never arbitrary extra HP rows.
The existing screening wrapper may remove only its own rejection after native
screening admission; other profile, wallet, price and tender guards remain.

## Lazy warehouse preparation

The source first executes literal automatic-coupon selection against current
controls, customer DOB and source time. Disabled automatic selection, an
ineligible month or a zero DOB do not request coupon history. An unselected
profile cannot turn an eligible history request into a false empty result.

At the first actual historical SELECT, `NeedCouponHistory` leaves the source's
broad `except Exception` path before executing SQL, writing a birthday claim,
creating an order or dispatching an effect. The preview returns only the bound
operation/request/plan/customer/coupon/configuration hashes, source execution
wall second/timezone and current head witness. After the owned transaction has
rolled back and closed, it observes the actual legacy birthday Redis key and
signs a separate, purpose-bound presence observation. No native historical
counts or publisher refresh are performed by this path.

`sourceOrderPreparation()` calls the injected `couponHistoryReader` only after
that authenticated escape, outside SQL and before the native order dispatch.
The port must be a qualified BigQuery consumer of an existing complete
publication. Missing/unqualified/stale/oversized facts are a local preparation
failure, not an unknown source order. There is no historical MySQL fallback.
There are at most three previews, one membership read and one coupon read;
both original copied documents survive all later previews. The callback honors
its abort signal and native attempt deadline.

The coupon capsule has a 300,000-byte ceiling and the core's combined sealed
artifact remains bounded to 1 MiB. Its scope, generation, document digest, current
control-head witness and legacy-guard observation are separately HMAC-bound.
Keys for the Node financial journal, source transport, source proofs, membership
history/publication, coupon history and birthday observation are independent.
Expiry is capped by the native attempt, source execution second, observed guard,
fetch lifetime and source-day end. Membership capabilities are also clipped and
re-signed to the native attempt when a slower preview shifts their upper bound.
The private order capability is capped by both selected capsules. The copied
coupon lifetime is checked again after actual native writes, immediately before
the late head fence and financial receipt. No retry extends an expiry or picks
a newer generation. Repeated cart passes use the immutable copied document and
scope/lease checks rather than re-encoding its entire JSON under row locks.

## Native source transaction

`NativeCouponHistoryHeads` validates the actual review trigger definitions and
three current heads without fetching historical rows. Its invocation owner is
set outside `CURRENT`, after the existing fresh authority/customer lock, using
the authenticated source order nonce. It never holds head locks across
Cart→Order. After the actual PosOrder/HP/refund/grant writes and benefit
descriptors, it validates native trigger deltas and obtains the late locks;
foreign changes reject the transaction. Its physical outer-commit guard checks
the final held heads. Legitimate source SAVEPOINT releases are distinct from
an actual COMMIT. Review SQL/manifest deployment and all-writer acceptance remain
required; a flag/cache value alone is not that proof.

Current coupon reads remain on the owned writer and are bounded/bound. Native
coupon-history SQL, including imported aliases, is refused before execution.
The only head-capture exception is the exact `SELECT id FROM orders LIMIT 0`
or `SELECT id FROM order_coupon_log LIMIT 0` metadata/MDL statement; it cannot
return a historical row. The original native `CONVERT_TZ(now(),'UTC',
'Asia/Kolkata')` validity predicate is preserved. A MySQL instance without named
timezone data refuses coupons; tests use a separate timezone-initialized local
MySQL image, not a predicate rewrite or host timezone-table mutation.

The selected native adapter exhaustively accounts for original lines, actual
source POS selections, authenticated member additions/replacements, source
header/customer/store/counter/method/status, wallets, amounts and exact HP hashes.
Complementary selections are original CSV type4 products, quantity 1; their
FREEBIE IDs, actual POS_MANUAL grant, source price rule and exact refund inputs
are recorded. No arbitrary free lines, blanket coupon allowance, inferred cash,
stock confirmation or provider calls are added. A discount/tender mismatch
retains the real signed no-effect calculation for the manager correction path;
it does not silently change tender, invent change or remove an automatic offer.

The pre-order stock check uses one unit only for a selected, writer-current
offline type4 product; repeated CSV additions still select one free HP. Normal
products retain declared quantities. Shopify retains original plan quantities
even when its free HP is one. Current store-association availability checks stay
intact, matching the literal PosProductDetail scan path.

## Two narrow technical source corrections

The private receiver now uses the exact pinned `AuthHandler.py` user projection,
rather than placing `SELECT users.*` into coupon meta. Native credentials and
unrelated SQL columns remain authority inputs. Birthdate uses the source auth
cache's JSON-safe string representation; current wallet numbers are preserved.
This fixes literal Cart.json() failure with a fresh SQL DATE while retaining
source-visible identity fields. The source AuthHandler and Constants files are
pinned inputs.

In aggregate mode the pinned `PosFreebieWrapper` provides no `gst` key, but
`build_has_products_model(is_free=True)` later reads `product['gst']` at
`libs/OrderHelper.py:688`. This raises KeyError despite the same function having
already forced free invoice_gst=0. Its per-unit branch already uses
`product.get('gst',0)`. The selected complementary adapter copies only an actual
free-branch input missing that key and adds gst=0 before delegating all original
arithmetic. It does not overwrite a present GST value or change ordinary product
dictionaries. The unmodified aggregate failure and corrected literal
aggregate/per-unit results are executable tests. No source sibling is edited.

## Integration hooks

- Node: existing `configuredSourceOrderPreparation` / `sourceOrderPreparation`
  accept `dependencies.couponHistoryReader: CsvCouponHistoryPort`. New optional
  Node keys: `CSV_COUPON_HISTORY_KEY`, `CSV_COUPON_GUARD_KEY`.
- Source: `POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT`,
  `POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT`,
  `POS_LEGACY_IMPORT_COUPON_HISTORY_KEY`,
  `POS_LEGACY_IMPORT_COUPON_GUARD_KEY`, and the existing qualified
  `POS_LEGACY_IMPORT_BIRTHDAY_GUARD_CONTRACT`. No default feature selection.
- The private factory supplies `NativeCouponHistoryHeads(sourceProofKey)`.
  Source constructors/default-off modes perform no new connection or history
  query. Retained source publication/public recovery resources are unchanged.
- Copy/hash new benefit helpers `benefit_controls.py`, `benefit_fence.py`,
  `benefit_native.py`, `benefit_runtime.py`, `coupon_handoff.py`, plus the parent
  head helper and its `coupon-history-writers.review.json`. Include the changed
  `benefit_profile.py`, `benefit_source.py`, source receiver/runtime/protocol/
  preparation files and parent `transaction.py` in the generated artifact.
  The generator and application/env wiring remain root-owned.
- Existing rewrite birthday claim SQL is reused. Source coupon-head triggers
  and the physical FREEBIE enum extension remain explicit reviewed deployment
  inputs, not runtime DDL.

## Evidence and limits

`tests/legacy-import-preparation/benefit-preparation.test.ts` covers both history
orderings, exact copied generations, no-history paths, unavailable/changed facts,
bounded repeated escapes and the member deadline regression.
`benefit-transport.test.ts` checks order-only hashes/marker/deadline and retained
later-stage ABI. `tests/legacy-import-benefits/runtime.test.ts` runs literal
eligibility, scope/key/tamper/expiry/source-midnight/alias fences, fresh-user
projection and original/corrected GST tests. The network-none real-dependency
SourceRuntime probe initializes all ten wrappers with zero external calls.

`benefit-source.mysql.test.ts` exercises the actual private source method chain,
real receiver, current native authorization, original SQL/order/HP/refund/grant
writes, native tracking triggers and head fence. Mongo/catalog/pricelist and the
nonpersisted cart store are explicit fixture inputs; BQ documents are signed
synthetic test publications. These tests are not production pricing, BigQuery
publication, provider, customer-wide legacy cache or all-writer cutover
acceptance. The generic generation publisher/qualified BQ runtime consumer and
its integration are separate root/checkout-owned work. Live activation remains
off until those concrete prerequisites and source clock/schema/cooperation are
accepted.

The source-only screening preview remains a separate code integration until the
specialized current-counter handoff lands. A server-installed
`pipeline.preparation_scope(session,user,plan,cap)` seam now runs after current
owned authority and before the unchanged read-only/history guards. It is absent
for ordinary pipelines. No current screening SELECT was exempted or replaced by
zero in this slice; the reporting agent owns that specialized replay and tests.

Run the timezone-qualified native suite with
`POS_LEGACY_IMPORT_SOURCE_ROOT=<clean-pinned-source> tools/legacy-import-benefits/run-source-tests.sh`.
The script uses the cached pinned MySQL image, a loopback ephemeral port and
unique disposable schemas, verifies named timezone conversion, runs the eleven
native cases serially, and removes its container even on failure. The separate
`SOURCE_BENEFITS_MYSQL_TEST_URL` is intentionally distinct from ordinary host
checkout fixtures. The final native case uses a real staged CSV, the actual
signed source rejection, manager correction and required approval before the
corrected source order; it preserves the original 50.98 declaration and original
rows while explicitly attesting 45.00. It stops before provider confirmation.

Focused handoff verification passed: 102 unit/source/transport cases, the eleven
native source cases, five source-session/bootstrap tests, both owned strict
TypeScript configurations and changed TypeScript lint. The separate real-package
SourceRuntime Docker probe ran with networking disabled and reported zero
external calls. These are scoped implementation receipts; they do not certify
an external warehouse publication or live runtime selection.
