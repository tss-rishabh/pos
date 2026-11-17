# Screening lifecycle integration

Node now composes screening admission, source receipts and immutable outcomes. Screening remains unselected until the separate source/Go/all-writer contracts are qualified. [Source profile evidence](legacy-import-screening.md) describes the original COUNT/HP-marker behavior and remaining source prerequisites. This is focused evidence, not certification of the complete CSV pipeline.

## Resulting behavior

Ordinary imports run through the original adapter without screening options or screening tables. Unconfigured screening is refused by `authorizeStart` before queue claim. Constructors perform no database work.

Qualified admission runs in a nested savepoint inside the first financial reservation transaction, immediately after its operation insert. Operation and screening reservation commit together. The original start owns dispatch; no external pre-reservation accidentally converts that first start into reconciliation.

The private source wrapper creates/binds Order, HP and screening markers in its existing outer source receipt/hold transaction. Node attaches the retained source receipt before native Order proof locks. Completion updates screening to `COUNTED` only after the original immutable financial proof verifies. A permanent original source no-effects rejection can release `RESERVED` quota; an uncertain response cannot.

Native quota/catalog refusal uses a separate signed local rejection. Profile writes roll back to savepoint, while the outer operation and rejection proof commit atomically. The queue returns `FAILED`; GET/exact-command replay returns the original rejection with no order call or new nonce. Driver/unknown/proof failures are not business refusals. Lost outcomes recover through GET without fabricating a source receipt or retrying an unknown effect.

The retained lookup now finds its original customer through the locking, cryptographically verified financial journal. A plain RR snapshot hint could miss a first reservation committed while a concurrent request waited for authority locks. The twenty-start native test exercises this correction. The common load boundary first calls exported `lockFinancialImportStore`, preserving Store → original operation → customer → Order/reservation ordering on dispatch/read/recovery. A native blocked-Store/NOWAIT test proves the operation is not locked first. Root must retain this lock before delegating to its correction-aware record loader; immutable receipt reads do not add a current-original-actor requirement.

## Trusted internal API

`financial-adapter-profiles.ts` exports `financialAdapterProfiles`, `FinancialImportProfileContext`, `FinancialImportProfileHooks`, and `FinancialImportProfiles`. Root can construct:

```ts
const profile = screeningImportProfile(config, db, {
  financialSecret: financialOptions.secret,
  proofKey: financialOptions.sourceProofKey ?? '',
  contract: selectedScreeningProfileContract,
  schemaContract: selectedScreeningSchemaContract,
  writerContract: selectedScreeningWriterContract,
  clock: financialOptions.clock,
});
const profiles = financialAdapterProfiles({
  screening: { profile, lineItemsEnabled: qualifiedSourceLineItemsEnabled },
  extensions: qualifiedOtherProfileHooks,
});
const adapter = legacyOrderImportFinancialAdapter(
  config, db, financialOptions, undefined, profiles,
);
```

Exact contract literals remain `pos-csv-screening-2960-v1`, `pos-screening-schema-v1`, `pos-screening-all-writers-v1`. The real boolean line mode comes from a qualified source deployment setting. No CSV, public operation ID or request body installs hooks or chooses this setting. Root owns env parsing/app construction. No options means ordinary imports allowed and screening refused.

The journal accepts the same port as argument four. It calls `reserved` within the initial transaction and `dispatch` before checkpoint insertion. The adapter calls `lock` before native Order proof reads, then `sourceReceipt`, `completed`, or `rejected` at verified evidence boundaries. Hooks perform native admission/evidence work only; transports run after transactions close.

The membership composition seam is:

```ts
expectedQuantities(tx, {state, plan}, order, phase: 'staged' | 'settled')
  : Promise<ReadonlyMap<string, number> | null>
```

Maps contain bounded positive SKU quantities; conflicting maps fail closed. Root owns consuming a verified map in writer/proof helpers. This patch does not substitute a changed plan or edit those helpers. Current membership entitlement belongs only at staged/settled mutation gates; completed reads retain frozen proof instead. Method15 can remain staged at both gates according to its independently qualified helper. Correction is opaque: state spreads retain it, local denial binds existing plan/request hashes, and Root owns correction-aware load/hash/source-command integration.

`journal.dispatch` projects exactly actorId/operationId/storeId/counterId before its stage HMAC. Structurally compatible plan/correction fields cannot leak into that scope.

## Native admission proof

Only `FinancialImportAdmissionDenied` with `ORDER_IMPORT_SCREENING_LIMIT` or `ORDER_IMPORT_SCREENING_CATALOG_REVIEW` is caught from the admission savepoint. A matching driver message/code is insufficient. The proof is:

```ts
{
  contract: 'pos-import-native-admission-v1',
  scope: {actorId, operationId, storeId, counterId},
  planHash, requestHash,
  namespace: 'pos-import-v1:' + operationId,
  code, noFinancialEffects: true, nonce, // immutable UUID
}
```

It uses existing financial stage storage: preparation/rejected, canonical stage request HMAC and separate `native-admission-rejection` proof HMAC. The operation is rejected/preparation with no order. No source/payment receipt or replacement operation is manufactured.

Verification checks exact scope/hash/namespace/code/nonce/status and absence of any additional stage, binding, source receipt/effect, close impact or completed proof. Every stage for the operation is inspected, so a changed kind/status cannot hide a contradictory checkpoint. Verification precedes screening lookup because local refusal has no committed screening reservation. A valid local rejection remains readable/replayable without a screening port. The traced rejection uses stage preparation; no error object, customer/CSV data or credentials are logged.

Original source no-effects rejection remains a separate protocol. The source-only correction classifier must not treat this as a rejected source order.

## Root registration and remaining gates

1. Pass the trusted profile port in the financial runtime; retain default refusal if any qualification is absent. No frontend/API bypass is required.
2. Register reviewed reservation DDL/migration/readiness and Docker SQL packaging for `pos_rewrite_import_screening_reservations`; its exported DDL is never auto-applied. Native admission proof needs no new table/column.
3. Add a forward `operation_id` index on `pos_rewrite_import_financial_close_impacts`. Its no-effects check must see every contradictory operation row; the current schema otherwise has only an ID primary key. Other evidence queries use existing operation/primary indexes.
4. Complete the independently owned source wrapper/Go/all-writer participation before enabling contracts. Current Go Confirm's Order-first hook is not qualified global Store/customer/Order admission. Preserve signed capabilities, deferred effects, import holds and no-duplicate fences.
5. Merge Root's correction-aware record/hash helper without discarding optional state metadata or spreading it into scope. This slice leaves source/proof/writer/correction semantics to their owners.

No production flag, live data/schema, protected source repository, provider or message sender is changed here.

## Validation

The focused suite contains **38 checks: five pinned source/pure and 33 isolated MySQL**. It covers original source arithmetic/marker semantics, ordinary dispatch without optional tables, atomic reservation, two-store/twenty-start contention, early Store lock ordering, source/publication/worker lost replies, GET-only reconciliation, source release, local denial/savepoint rollback, denial persistence failure, driver errors with denial-like text, HMAC/nonce tampering, contradictory checkpoints, full-width IDs and canonical scope hashing.

From backend with Node 24:

```sh
node node_modules/typescript/bin/tsc --noEmit -p tests/legacy-import-screening/tsconfig.json
node node_modules/eslint/bin/eslint.js src/modules/legacy-order-imports/{screening-profile,screening-contracts,financial-adapter-profiles,financial-adapter-admission,financial-adapter-journal,financial-adapter}.ts tests/legacy-import-screening
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  node node_modules/vitest/vitest.mjs run --config tests/legacy-import-screening/vitest.config.ts
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  node node_modules/vitest/vitest.mjs run --config tests/legacy-import-screening/vitest.regression.config.ts
```

The second config runs 27 existing financial adapter/native-source/approval and disabled-runtime regressions in its own cache with one worker. Native schemas are disposable localhost fixtures; the lock test reads only synthetic schema metadata, and queue acknowledgment is synthetic. Source/Go/provider acceptance remains independently qualified. No browser/shared build or port is used.
