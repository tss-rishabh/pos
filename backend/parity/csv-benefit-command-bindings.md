# Immutable CSV benefit selection and prepared coupon history

`financialBenefitContractsSchema` is a strict, nonempty, optional marker:

```ts
{ automaticCoupon?: 'pos-csv-automatic-coupon-v1',
  complementary?: 'pos-csv-pos-complementary-v1' }
```

Only trusted installed `financialAdapterProfiles` options select it. HTTP/import DTOs do not accept it. Unselected operations omit the field entirely; no default null/empty object is introduced into old state, request HMAC or financial completion bytes. Empty/unknown markers are refused. The selected options are copied and the marker frozen so changing a caller's configuration object cannot enable behavior after reservation.

New operation `requestHash` authenticates the selected marker with its original scope/plan/authority and any original correction/preparation bindings. Native record reads authenticate the saved marker before comparing installed flags. Reserve/dispatch/resume and profile mutation gates refuse a changed binding rather than rehashing an old command. A correction successor derives its marker from the authenticated original native operation and requires the installed source profile to match; changing current flags cannot silently alter that successor's source behavior. Its independent correction evidence, fresh approval, original products/prices/customer and authority remain mandatory.

New financial seals retain the optional marker. Original completed receipts are authenticated before current profile/configuration checks, including lost-ACK recovery. Existing unmarked completed receipts stay unmarked when new profiles are selected. Marked receipts survive disabled/bad new-work flags. A newly authenticated benefit snapshot with a marker must stay within its frozen selected contracts; old correctly signed financial documents keep their original field absence.

## Sixth preparation output

`FinancialOrderPreparationPort.prepare` returns optional `membershipHistory` and `couponHistory`. `couponHistory` is the strict `CsvCouponPrefetch` from `benefit-profile/bridge.ts`: exact complete history document, signed capability, current source witness and signed legacy guard observation. A selected coupon contract does not force a history request when the actual source preview says none is needed. An artifact supplied to an unmarked/non-coupon command is refused.

The ledger validates the outer UTF-8 byte bound before nested schema work, caps a coupon capsule at 300,000 bytes, and caps both artifacts together at 1,048,576 bytes. Each document/capability must share its exact operation/request/plan/customer scope and generation. Both expiries must be current and no later than the owned attempt expiry. It then authenticates the exact output hash and encrypts it with AES-GCM under scope/request/attempt AAD before creating the one order checkpoint. Maximum encrypted size is 1,398,140 bytes including the 28-byte nonce/tag overhead and base64 expansion.

The plaintext source request remains separately bounded: a 256,000-byte plan, at most 16,000-byte native state/capability each, and the aggregate 1MiB artifact fit within the source adapter's existing 1,400,000-byte body ceiling. The transport owner must preserve that exact UTF-8 check before fetch. Only the order source capability carries the original `benefitContracts` and `financialSourceHash(authKey,'coupon-history',wholeCapsule)` binding; later Go confirmation ABI is unchanged.

Preparation ownership/queue claim, native request HMAC, attempt lease, late-result rejection and append-only no-dispatch closure continue to fence dispatch. No SQL lock spans provider I/O. GET cannot begin/rearm an attempt or request another generation. Explicit resume authenticates the original marker and authority before authorizing a new nonce. Reading an already dispatched encrypted artifact preserves its original expired evidence; it never makes that artifact eligible for a new dispatch. A valid financial completion seal remains readable even if the old artifact is later corrupt.

## Scope and verification

This core change does not install/activate the source coupon capsule, BQ publisher/provider, native witness or all-writer/legacy guard cutover. Those remain independently qualified modules. Constructors remain pure, runtime flags stay unselected by default, and the existing changed-authority successor/reference-transfer limitation remains explicit.

Focused tests cover original HMAC bytes, strict marker parsing, capture of trusted options, purpose separation, both artifacts, bounds/scope/generation/expiry failures, native API/worker dispatch, authenticated saved-marker tampering, reserved unmarked commands, old completed commands under new/bad flags, exact no-dispatch resume, correction marker inheritance, and AES-GCM tamper refusal without changing a completed receipt. All existing late-attempt/no-dispatch/rearm tests remain required. Tests use generated signed documents and isolated native MySQL, never live providers/history or production mutations.

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  npx vitest run tests/legacy-import-preparation/benefit-bindings.test.ts \
  tests/legacy-import-preparation/adapter.mysql.test.ts \
  tests/legacy-import-financial/correction-integration.mysql.test.ts --maxWorkers=1
```

The schema marker is JSON-only and requires no SQL migration or public DTO change. Core integration requires the bridge prerequisite `3007b5e` plus the source transport's order-only capability/body checks before selecting any deployment flags.
