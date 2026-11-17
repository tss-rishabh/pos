# CSV membership lifecycle adapter

This server-installed adapter composes the existing source-qualified membership checker with financial import hooks. It does not activate a profile, change a tax/tender/stock formula, implement a provider, or edit the source receiver. Source/Go and native revision-fence acceptance remain separately qualified. Product identifiers and the free-member identifier come only from trusted deployment options.

## Composition and ordered authority

```ts
const member = csvMembershipImportProfile(trustedMembershipOptions);
const profiles = financialAdapterProfiles({ extensions: [member] });
```

`trustedMembershipOptions` has the existing `CsvMembershipOptions` shape: `contract`, `sourceProofKey`, `membershipProofKey`, `freshReaderContract`, `productIds`, `freeProductId`. The constructor copies/validates the product registry and performs no database work. A planned configured member SKU requires the selected membership contract, fresh-reader contract, independent proof keys and a valid configured free SKU. An unselected profile permits ordinary imports; it cannot infer a member SKU from request data or a guessed constant.

The caller must already hold current actor/Store/original-operation authority. `lock(tx,context)` inspects current immutable source-descriptor metadata without loading oversized JSON, then takes the exact native customer row before any native Order/provenance read. A private transaction/scope witness prevents a different transaction or altered scope from reusing that early lock. `dispatch` installs the same gate. No helper holds SQL locks across HTTP.

The descriptor query is deliberately not filtered by JSON size or source status. It bounds row count and uses CASE to avoid loading an oversized body while keeping its existence visible. Any retained unqualified, malformed, oversized, noncanonical, wrong-status/hash or incorrectly bound descriptor refuses. This includes an otherwise nonmember plan with disabled options and a row committed after an earlier RR snapshot. SQL/driver failures propagate; absence is not fabricated from a failed query.

`sourceReceipt` checks the signed explicit descriptor against the original source order and trusted product registry. It does not demand STAGED entitlement again after method14 activation. `expectedQuantities(tx,context,order,phase)` invokes `assertCsvMembershipProfile` only at staged/settled mutation gates and returns its exact explicit quantity map. The native checker retains current revision/EAV/header/customer/free-line checks.

For method14, staged checks precede Go and settled checks require the independently verified activated producer provenance. Method15 Shopify stays STAGED in both phases. Neither adapter nor quantity map changes `plan.lines`: Shopify stock work must keep using the original source plan, including when a sealed source receipt documents an additional free member line. Equal cart quantities are never membership provenance.

The adapter exports the trusted internal hook property `requiresCurrentReads: true`. Root must aggregate it into its owned READ COMMITTED runner before opening the financial transaction. This avoids irrelevant RR gap locks from the native membership fence's empty-entity MDL read. The property cannot be supplied by a public request. This module does not silently change an already-open transaction's isolation or retry a lock failure.

## Immutable completed proof

`completionSnapshot(tx,context,order)` runs the settled checker while creating a new financial completion, then returns null for a genuine ordinary import or:

```ts
{
  receipt: CsvMembershipReceipt,
  sourceReceiptHash: string, // original membership descriptor proof_hash
}
```

The strict `csvMembershipCompletionSnapshotSchema` bounds the complete snapshot to 262144 UTF-8 bytes. Root must include the entire snapshot in the existing authenticated financial completion, and budget its bounded payload in the native/history proof readers. No customer contact or raw CSV field is added to it.

`validateCsvMembershipCompletionSnapshot(snapshot,completed)` takes only:

```ts
Pick<ImportCompletedProof, 'scope' | 'planHash' | 'requestHash' | 'authority' | 'kind' | 'order'>;
```

Call it **after authenticating the enclosing financial proof**. It is structural read validation, not standalone authentication of untrusted input. It binds operation/actor/store/counter/customer/method/hash/namespace/HP identity and explicit member manifests to that immutable proof. It does not decrypt a plan, read EAV/contact state, require current flags/product settings, or re-sign with current source/member keys. The original staged membership receipt and its original proof hash stay retained after legitimate activation or later entitlement changes.

The provenance header hash remains the original checkout financial digest; the source order header hash includes the import's separate address/time envelope. They are checked in their respective creation-time contracts, not equated during historical reading.

`lock` deliberately skips mutable membership requirements for completed state; the root financial proof must still authenticate and pass its independent structural ownership checks. A completed flag without a valid financial seal grants nothing. Never call the mutable expected-quantities checker to authorize an old completed receipt.

## Root integration checklist

1. Install the server-created extension in the financial runtime even when optional profile selection is absent. Existing descriptor detection must not disappear when the contract is disabled. Keep planned member admission selected only after independent source/Go/native-fence qualification.
   Aggregate its trusted `requiresCurrentReads` property into the owned financial runner before BEGIN, preserving current authorization and ordered locks.
2. Invoke the early `profiles.lock` before every native Order lock. In particular, the method14 post-confirmation path must call it before `assertCheckoutProjection`; Order-first confirmation cannot be repaired by a late callback.
3. Add the typed completion-snapshot hook to the profile composition, obtain it before inserting/sealing a new complete financial proof, and include its strict nullable value in the finalized proof schema/HMAC. Missing/malformed evidence must not be replaced with null.
4. On an authenticated completed read, validate the frozen snapshot with the minimal immutable scope. Keep current actor/store authorization and the existing completed-order structural checks. Do not require current original-customer contact/entitlement/source-key equality.
5. Retain the independently qualified original Go14 activation and method15 staged/stock behavior. No public JSON can supply product IDs, an expected map, profile callbacks or a bypass operation ID.

## Focused verification

The new native tests use guarded randomly named localhost schemas, verified source types, native hashes, the real membership revision triggers and the existing native checker. They exercise method14 staged/activated transitions, method15 staging, explicit free additions without plan mutation, customer-before-Order waiting, missing witness, malformed/oversized/disabled descriptors, stale RR presence, late rollback and immutable reads after contact/entitlement/key/flag changes. Synthetic activation in this component suite is not an additional claim that Go ran here; the separate cross-language producer suite owns that evidence.

The focused run passed 51 checks: 18 new native checks, 15 new pure checks and 18 existing descriptor-domain regressions. The pure tests cover minimal historical bindings, bounded snapshots, changed scopes/manifests/HPs and trusted-registry configuration. Strict TypeScript, owned lint and formatting also pass. This component evidence does not establish deployed source/Go/runtime acceptance.

```sh
node node_modules/typescript/bin/tsc --noEmit -p tools/legacy-import-membership/tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  node node_modules/vitest/vitest.mjs run \
  --config tests/legacy-import-membership/adapter.vitest.config.ts
```

No production row/schema, source repository, provider, email, message or infrastructure is changed by these checks. Root owns financial proof/runtime registration and consolidated integration validation.
