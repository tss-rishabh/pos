# Membership snapshots in financial import completion

The financial core now installs the membership descriptor guard by default, freezes a qualified full snapshot at settled completion and includes it in the original financial HMAC. Source/Go contracts remain unselected. Runtime construction, private transport/history handoff, source deployment and production acceptance remain independently qualified.

## New work

`financialAdapterProfiles({membership:trustedOptions})` installs one server-created membership adapter. With no options, the same mandatory guard is present but member admission is unselected. Existing membership descriptors cannot be ignored merely because the original plan and generated HP quantities match or there is no additional free line. Malformed, oversized, wrong-status/hash or unqualified descriptors stop the lifecycle before confirmation, stock settlement or publication. No source negative receipt is fabricated for such a failure.

Trusted hooks expose `requiresCurrentReads`. The composition aggregates that property, the journal uses the existing owned READ COMMITTED runner before BEGIN, and selected work does not retry deadlock/timeout failures. The old `currentScreeningReads` property is removed from callers. Existing actor/epoch → Store → original operation ordering and correction-aware record/hash handling remain intact. Post-Go confirmation retains `profiles.lock` before `assertCheckoutProjection`.

Before inserting a new completed proof, `profiles.completionSnapshot` runs the settled native checks and produces the strict full snapshot. Method14 requires its independently verified activated provenance; method15 remains STAGED, and Shopify stock still consumes original `plan.lines`, not the source's additional member line.

The private source emits exactly one `pos_import_invalidate_membership` intent whenever `cacheInvalidations` is positive, including a count of two. Completion requires exactly one acknowledged `membership-cache` job in that case, and none for zero/no snapshot. This checks broker acceptance and the original source `effectsHash` binding. It does not assert that Redis invalidation has completed; the separate durable consumer keeps uncertain outcomes quarantined.

## Immutable recovery and a lost commit acknowledgment

`readAuthenticatedImportCompletion` first bounds the stored proof without filtering away an oversized row, validates its exact financial HMAC, then checks frozen membership/correction/publication bindings. No current member/source key, flag, contact, EAV row or product setting authorizes this read. Old ordinary proofs retain membership-field absence, with no default-null injection into their HMAC bytes. An old proof without a snapshot cannot qualify an existing membership source descriptor.

`recoverImportCompletion` binds that authenticated proof to the original native journal context, locks the retained customer before native Order ownership checks and permits later legitimate status/price/contact/entitlement changes. Generic already-locked mutation guards keep their established ordering and use the same authenticated proof/structural validation without adding a late customer lock.

The adapter checks for a valid completed seal **before mutable profile gates**, including when an old lost-ack path left journal status `unknown`. A successful recovery repairs that journal classification to completed with the same original order/receipt. `journal.uncertain` also verifies and preserves/repairs a completed result instead of unconditionally downgrading it. A flag alone never grants this exemption: unknown/completed status without a valid seal remains behind the normal gates or fails explicitly.

New-only transport configuration/schema preflight runs inside reservation before operation insertion. An exact completed replay does not require the source contract to be currently enabled. Real transport calls remain outside SQL transactions; `assertReady` is configuration-only. No recovery path starts a second order, payment, stock action or publication.

The retained financial master/V1 key is still required to authenticate native journal/financial evidence. This is not a claim that replacing that retained key can decrypt/authenticate old data. Source/member keys and current admission flags can change without reauthorizing an accepted completion.

## Runtime hook

Root can construct the profile port without I/O:

```ts
const profiles = configuredFinancialImportProfiles(financial, environment);
const adapter = legacyOrderImportFinancialAdapter(config, db, financial, transport, profiles);
```

`membership-profile/options.ts` exports that factory and `readCsvImportMembershipOptions`. They accept only trusted environment/configuration, with static errors that do not serialize values. The source proof key comes from validated `financial.sourceProofKey`, not a second environment alias. Exact environment inputs are:

- `POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT=pos-legacy-import-membership-v1`
- `POS_MEMBERSHIP_FRESH_READER_CONTRACT=pos-membership-fresh-reader-v1`
- `POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT=pos-membership-native-revision-v1`
- Existing independent `POS_MEMBERSHIP_PROOF_KEY`
- Trusted JSON string-array `POS_MEMBERSHIP_PRODUCT_IDS`
- Existing source identifier `EXCLUSIVE_QUARTERLY_ID_FREE`

No SKU/free identifier is guessed. Empty/unselected options retain the guard and refuse member admission. The strict options reader reports selected incomplete or malformed configuration with a static code. The configured composition factory catches only that exact configuration error and supplies a port that blocks all unfinished/new work while retaining authenticated completed-proof recovery. It does not silently admit ordinary plans or manufacture product settings. Runtime must keep the recovery adapter available when the retained financial key exists even if current transport readiness is disabled; otherwise it would hide immutable reads at application integration. New work still fails its preflight before any operation insert. Demo/disabled startup must retain its existing no-I/O policy.

## Focused evidence

The membership/core suite passed 80 checks. The native cases run the actual financial adapter/journal, source-signed descriptor/native EAV revision checks, stock projection and proof readers in disposable localhost schemas. Test transports acknowledge only synthetic original stages. A deterministic test lets the final native COMMIT become externally visible, then throws before its acknowledgment while disabling readiness/source key and changing contact/block/EAV/descriptor data. The original completion is recovered with one order/publication and no repeat financial action; a simulated old unknown flag is repaired through the configured recovery port with invalid selected settings.

Additional cases cover method14 activation, method15 staging, free-line stock conservation, source cache acknowledgment mismatch, HMAC-before-frozen-binding validation, tampered/re-signed mismatched snapshots, unqualified legacy omission, oversized proof refusal, flags without seals, early customer lock waiting and new unconfigured dispatch without an operation insert. The separate existing source/Go suites own actual upstream execution/acceptance evidence.

This checkpoint also passed 46 screening source/native checks and 55 existing financial/source/correction checks. One Go-binary-dependent case was skipped because `POS_IMPORT_CORRECTION_GO_BINARY` was not supplied; no new Go acceptance is claimed here. Source cases use the immutable API-v2 2960 archive through `POS_LEGACY_IMPORT_SOURCE_ROOT` and `SCREENING_SOURCE_ROOT`; protected source repositories are unchanged. The source-fixture admission correction f2cd69c is a dependency, not part of the financial change.

```sh
node node_modules/typescript/bin/tsc --noEmit -p tools/legacy-import-membership/tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  node node_modules/vitest/vitest.mjs run --config tests/legacy-import-membership/adapter.vitest.config.ts
```

No live provider, production row/DDL, source application, message, infrastructure or shared frontend build is changed by this slice.
