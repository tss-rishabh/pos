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

Staged and settled verification checks native HP price/discount/refund hashes, exact grants and no extra trigger rows, source coupon controls, actual claim/history binding and every source coupon assignment. Wallet, points, cashback, vouchers, parent orders and funded vouchers retain their original blanket refusal. A coupon ID is allowed only when that qualification proves the exact source header value. An unqualified FREEBIE HP is refused even if its quantity happens to match the CSV.

Method 14 settlement requires the original authenticated source confirmation receipt and matching confirmed nonce. The coupon-consumption descriptor must bind that exact confirmation HMAC, staged receipt, order/customer/store/counter, original assignment deltas and actual log ID/hash. Missing or newly signed wrong confirmation evidence cannot authorize cash recording. Method 15 never acquires a consumption receipt; Shopify stock still follows original `plan.lines`, including declared gift quantities that differ from actual HP quantity 1. No TypeScript discount/tax/refund formula is added.

The read-only coupon-control check uses SHARE and does not upgrade an already-held shared control lock. Assignment rows remain locked in native ID order. No transport or historical query runs inside these native transactions.

## Immutable completion

The final common financial HMAC optionally seals `benefits` with coupon, complementary and activation receipts/seals plus the exact source `confirmationHash`. No default null is injected into old ordinary HMACs. The pure `benefit-profile/completion.ts` validator runs semantic scope/HP/consumption checks only after authentication of that outer financial document. Method 14 coupon completion requires activation and a matching confirmation hash; method 15 requires null confirmation/activation.

Completed recovery does not consult current source/profile keys, contact, catalog, entitlement, counters, claim expiry, Redis or mutated source descriptor rows. Current immutable Order/customer/store/counter/HP identity checks remain in the common proof reader. A legacy ordinary seal with no benefits field cannot bless a subsequently present benefit descriptor. The older standalone `validateCsvBenefitCompletion` is retained as a staged snapshot helper; the financial core uses the stronger financial snapshot validator.

## Explicit remaining integration and conservative edge

Installation of the isolated source benefit capsule, complete birthday-history publication/provider, legacy guard cutover and final private receiver/Go deployment acceptance remain separate integration requirements. This Node composition does not manufacture empty historical usage or a legacy Redis cache miss. Current preparation output is strictly membershipHistory-only; a source birthday prefetch requires its own approved preparation artifact/capability extension. Production flags remain blank.

Before a financial seal exists, the conservative settled verifier still requires current coupon controls/counters to match its captured confirmation. A newer counter/control change in that interval freezes the operation with its original Go evidence retained; no automatic immutable-Go-only completion path for that case is implemented here. Missing/changed consumption and counter tests prove no cash, publication or repeated deduction is fabricated. Changed original actor/contact authority likewise retains the existing explicit-successor limitation. Those are code/reconciliation edges, not certificates of source equivalence.

Source table indexes need the reviewable proposals in `csv-benefit-query-improvements.md` before production workload qualification. No live DDL was issued.

## Focused evidence

Run the existing digest-pinned isolated TZ MySQL runner with the immutable API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` source archive:

```sh
POS_LEGACY_IMPORT_SOURCE_ROOT=/path/to/immutable-api-v2-2960 \
  sh compatibility/upstream/legacy-order-imports/benefit-profile/run-native-tests.sh
npx tsc -p tools/legacy-import-benefits/tsconfig.json --noEmit
```

The source/native checkpoint passed 95 cases before the separate query/privacy cases were added. Positive financial fixtures use the literal pinned calculator, HP constructor, POS grant and approved refund allocator. Shopify completion preserves original plan stock and no consumption. The cash case retains the original 104.47 input, records a signed source-calculated 45.00 rejection, then uses real native manager correction review, successor creation and historical approval before recording 45.00 cash exactly once. Missing consumption, a newly signed wrong confirmation and changed counters remain uncertain without cash/publication/resend. Completed snapshots survive disabled keys/flags and changed contacts/catalog/counters/source rows; outer-HMAC and inner-scope tampering are refused.

The Node fixture uses the independently pinned Python deduction oracle to emit the same consumption ABI after its controlled confirmation fixture. It does not claim a new real-Go/full-private-receiver roundtrip. Actual original Go consumption has separate `981d944` evidence and must be qualified with the final merged pipeline. No provider, live data, external broker or production writer is called.
