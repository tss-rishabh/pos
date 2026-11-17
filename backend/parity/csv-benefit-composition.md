# Node financial composition for CSV benefits

This wires the separately qualified coupon/POS-selection and membership readers into the real import adapter/runtime. It does not activate source profiles, historical publishers, a Go receiver or a legacy schema change. The existing correction, approval, current authority, stock and refund contracts remain mandatory.

## Runtime and contracts

`financialAdapterProfiles` installs `csvFinancialBenefitProfile` as its default combined membership/benefit hook. Ordinary imports keep absent membership/benefit fields absent. Any existing coupon-benefit, pos-complement or coupon-consume row is bounded and validated; an unselected, malformed, oversized, wrong-status or incorrectly identified descriptor cannot be treated as ordinary absence. Lookup also checks canonical receipt IDs so changing a purpose label cannot hide its known row.

`configuredLegacyOrderImports` installs trusted benefit options from these blank-by-default variables:

```dotenv
POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT=
POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT=
```

Their selected literals are respectively `pos-csv-automatic-coupon-v1` and `pos-csv-pos-complementary-v1`. The source proof key comes only from validated financial options. Invalid selected configuration denies new work while keeping the retained financial-key reader. Constructors perform no I/O. Go separately requires `POS_LEGACY_IMPORT_COUPON_CONSUMPTION_CONTRACT=pos-csv-coupon-consumption-v1` from its qualified overlay; the Node flags cannot substitute for it.

The rewrite-only birthday guard/claim migration is registered at `compatibility/upstream/legacy-order-imports/benefit-profile/migration.sql` and copied into the backend image. The separate review-only FREEBIE enum ALTER is not a rewrite migration and is never applied automatically. Native fixtures execute that exact proposal only inside disposable schemas.

## Current mutation authority

Caller-owned actor/epoch → Store → operation locks remain first. The combined hook locks the original customer before any Order/HP/coupon/grant work. It invokes the authenticated exhaustive HP ownership reducer, removes only separately proved original POS selections from the membership admission view, and then runs the existing independent current membership verifier on that view. Full retained plan/header/line hashes are preserved. The authenticated paid-member-to-free-member replacement remains the responsibility of the membership reducer; this layer does not reconstruct or waive it.

Each HP belongs exactly once to the original plan, independently proved membership, or original selected POS complementary product. A quantity map alone grants no asset permission. The native writer receives a module-private qualification tied to the exact SQL transaction, scope, source header/line hashes and staged/settled phase. A plain object, copied token or token from an ended transaction fails before the writer can use it.

Staged and settled verification checks native HP price/discount/refund hashes, exact grants and no extra trigger rows, and the original claim/history binding. Before a new use, current source coupon controls and every source assignment must match. After authenticated method 14 confirmation, the original sealed consumption replaces current control/assignment comparisons as described below. Wallet, points, cashback, vouchers, parent orders and funded vouchers retain their original blanket refusal. A coupon ID is allowed only when that qualification proves the exact source header value. An unqualified FREEBIE HP is refused even if its quantity happens to match the CSV.

Method 14 settlement requires the original authenticated source confirmation receipt and matching confirmed nonce. The coupon-consumption descriptor must bind that exact confirmation HMAC, staged receipt, order/customer/store/counter, original assignment deltas and actual log ID/hash. Missing or newly signed wrong confirmation evidence cannot authorize cash recording. Method 15 never acquires a consumption receipt; Shopify stock still follows original `plan.lines`, including declared gift quantities that differ from actual HP quantity 1. No TypeScript discount/tax/refund formula is added.

The new-use coupon-control check uses SHARE and does not upgrade an already-held shared control lock. Assignment rows remain locked in native ID order before new use. Consumed method 14 verification performs neither current lookup: changing another order's shared counter or disabling the coupon cannot erase the authenticated original effect. The exact original log, native order/HP/refund/grant integrity and independent confirmation remain mandatory. No transport or historical query runs inside these native transactions.

## Immutable completion

The final common financial HMAC optionally seals `benefits` with coupon, complementary and activation receipts/seals plus the exact source `confirmationHash`. No default null is injected into old ordinary HMACs. The pure `benefit-profile/completion.ts` validator runs semantic scope/HP/consumption checks only after authentication of that outer financial document. Method 14 coupon completion requires activation and a matching confirmation hash; method 15 requires null confirmation/activation.

Completed recovery does not consult current source/profile keys, contact, catalog, entitlement, counters, claim expiry, Redis or mutated source descriptor rows. Current immutable Order/customer/store/counter/HP identity checks remain in the common proof reader. A legacy ordinary seal with no benefits field cannot bless a subsequently present benefit descriptor. The older standalone `validateCsvBenefitCompletion` is retained as a staged snapshot helper; the financial core uses the stronger financial snapshot validator.

## Consumed facts and remaining integration

Installation of the isolated source benefit capsule, complete birthday-history publication/provider, legacy guard cutover and final private receiver/Go deployment acceptance remain separate integration requirements. This Node composition does not manufacture empty historical usage or a legacy Redis cache miss. Current preparation output is strictly membershipHistory-only; a source birthday prefetch requires its own approved preparation artifact/capability extension. Production flags remain blank.

The previously documented coupon control/counter change after Go but before the financial seal is closed. Settled method 14 verification authenticates the original Go consumption HMAC, its exact original confirmation HMAC/nonce, staged source receipt, immutable scope and exhaustive original counter deltas; it checks the original native log and full order/HP/refund/grant evidence. It does not compare that past event with today's assignment/control rows. Missing, copied or tampered evidence remains uncertain and cannot authorize cash or publication. [Consumed recovery evidence](csv-consumed-benefit-recovery.md) includes the actual original Go binary plus Node adapter/correction/approval flow.

New discretionary settlement/publication still requires the original current actor/contact/approval authority. A change there before those stages completes retains the explicit-successor/reference-transfer code limitation; no fake principal, new order or automatic resend is created. The original source proof key must remain available until the financial seal authenticates the complete evidence. Once sealed, lost acknowledgment and later key/profile/contact/catalog/counter changes recover through the retained financial proof only.

Source table indexes need the reviewable proposals in `csv-benefit-query-improvements.md` before production workload qualification. No live DDL was issued.

## Focused evidence

Run the existing digest-pinned isolated TZ MySQL runner with the immutable API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` source archive:

```sh
POS_LEGACY_IMPORT_SOURCE_ROOT=/path/to/immutable-api-v2-2960 \
  sh compatibility/upstream/legacy-order-imports/benefit-profile/run-native-tests.sh
npx tsc -p tools/legacy-import-benefits/tsconfig.json --noEmit
```

The initial source/native checkpoint passed 95 cases before the separate query/privacy cases were added. Positive financial fixtures use the literal pinned calculator, HP constructor, POS grant and approved refund allocator. Shopify completion preserves original plan stock and no consumption. The cash case retains the original 104.47 input, records a signed source-calculated 45.00 rejection, then uses real native manager correction review, successor creation and historical approval before recording 45.00 cash exactly once. Missing consumption and a newly signed wrong confirmation remain uncertain without cash/publication/resend; later unrelated counters preserve the original consumed fact. Completed snapshots survive disabled keys/flags and changed contacts/catalog/counters/source rows; outer-HMAC and inner-scope tampering are refused.

The initial Node fixture uses the independently pinned Python deduction oracle to emit the same consumption ABI after its controlled confirmation fixture. The consumed-recovery follow-up runs the independently reviewed original Go confirmation binary instead and passed 41 native cases including its existing 28 cases and 13 new Go-to-Node cases. This still does not claim a full deployed private-Receiver roundtrip. No provider, live data, external broker or production writer is called.
