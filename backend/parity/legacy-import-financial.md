# CSV financial receiver — integration core

This module supplies the private financial adapter for the durable CSV coordinator. The application and standalone worker register it only after configuration readiness passes; production contracts remain unselected. The private source receiver and Go overlay must be qualified and deployed together before activation. No upstream repository, live row, provider or infrastructure was changed.

## Wiring

`legacyOrderImportFinancialAdapter(config, db, options, transport?)` in `src/modules/legacy-order-imports/financial-adapter.ts` implements the existing `ImportFinancialAdapter`. Production omits the final test transport argument. Pass the result to the root-owned registration option `adapter`. Its `authorizeStart(tx,input)` checks schema/transport/native authority and the bound period grant before the coordinator changes PENDING to STARTING. Missing approval returns exactly `{ready:false,code:'ORDER_IMPORT_APPROVAL_REQUIRED'}`; readiness failures throw before dispatch. `start` never sends a previously reserved operation again. `read` only reads original native evidence and may seal already proved completion; it never starts a missing financial stage.

`legacyOrderImportFinancialApprovals(config, db, {secret,clock?})` exports:

- `request({approverId,scope:{actorId,operationId,storeId,counterId},plan,planHash,commandId,reason})` → `FinancialImportApprovalView`.
- `read(scope,planHash)` → the original view or null. A changed/expired grant returns `status:'stale'`.
- `read(scope,planHash,commandId)` → the exact original command's view or null, even when a newer grant exists. GET recovery never creates a grant or extends its expiry.

The server supplies the authenticated approver, original private financial context and exact plan hash. Reasons are `late-recording`, `historical-correction`, and `source-reconciliation`. Current internal roles 1–3, including the job owner, may approve their allowed active store/counter. A grant lasts one hour and binds the exact operation, actor authentication version/epoch, current customer contact, plan/prices, date and latest close version. Same-command replay retains the original expiry. Today’s open period requires the same private price/scope capability but no backdate grant. Historical dates and any closed/stale date require the explicit grant.

Apply `src/modules/legacy-order-imports/financial-proof-migration.sql` after the root staging, ordinary projection/consent/gift proof and contact-revision migrations. It creates nine rewrite-only journal/approval/stage/source-receipt/source-effect/completion/reference/close-impact/order-binding tables. It changes no legacy table and performs no backfill. The separately reviewed nullable unset-order-date profile remains required; SQL mode is not weakened.

`legacyImportFinancialOptions(env)` reads the retained `LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1` plus:

- `UPSTREAM_POS_LEGACY_IMPORT_FINANCIAL_CONTRACT=pos-legacy-order-import-financial-v1`
- `UPSTREAM_POS_LEGACY_IMPORT_SOURCE_CONTRACT=pos-legacy-order-import-source-v1`
- `UPSTREAM_POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT=pos-legacy-order-import-confirmation-v1`
- `UPSTREAM_POS_LEGACY_IMPORT_PUBLICATION_CONTRACT=pos-legacy-order-import-publication-v1`
- `TSS_POS_LEGACY_IMPORT_URL=https://private-host/internal/pos/legacy-order-imports`
- independent `TSS_POS_LEGACY_IMPORT_KEY` and `TSS_POS_LEGACY_IMPORT_PROOF_KEY`
- the existing ordinary JWT/projection/refund contracts, `POS_STOCK_PROJECTION_CONTRACT=pos-stock-projection-70b801-v1` and `OFFLINE_CASH_ORDER_SCHEMA_CONTRACT=pos-offline-cash-order-schema-v1`.

Supply the selected transaction-scoped `stockProcedure` separately; no CALL or implicit-commit stock routine is used. Keep every new contract unset until source qualification. The optional observer receives only closed module/resource/event identifiers, unique event instance, initiating request/operator and stage. It never receives CSV bodies, contacts, amounts, tokens or errors, and logger failure cannot revert financial completion.

## Native hold for other writers

Call `assertImportOrderMutationAvailable(tx,orderId,retainedSecret)` from `financial-adapter-proof.ts` inside the caller’s order writer transaction before financial work/checkpointing. Orders without a binding pass. Every incomplete binding fails with `ORDER_IMPORT_ORDER_HELD`; there is no public allowed-operation bypass. A completed binding requires the sealed immutable receipt and exact native customer/store/counter/HP ownership. A paid flag, HTTP response, draft or ordinary projection alone cannot release the hold. A missing proof cannot manufacture a replacement completion receipt. This same guard belongs on terminal dispatch, cancellation, returns/exchanges and their effects. The private source/Go candidates also fence their cooperating original writers. Unpatched independent legacy writers remain an explicit activation blocker.

## Source behavior preserved

The web source is `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`; API-v2 is `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`; payments is `434f3e438d1cb48c64e5723222c6efda506db571`.

Offline imports create an ordinary method14 order, confirm the original source stock/allocation transaction once, then record cash or manual-other settlement with the source custom date. The source `Helpers.complete_order(custom_date)` updates HP timestamps but leaves their PLACED status; this adapter preserves that branch. Its transaction reference is the generated order reference, not CSV SerialNo. Manual-other is a historical counter record; no provider charge/refund is inferred. Optional order SMS is a same-transaction durable existing outbox job, not a claimed delivery.

Shopify uses method15 and retains PENDING/order1/INCOMPLETE lines. It never runs ordinary confirmation or records collected counter cash. It changes the exact source input SKU quantities through the selected native stock transaction and queues inventory synchronization. Completion means source order/stock and durable producer queue acceptance, not payment or downstream Kinesis processing. Shopify source reference is claimed per store to prevent another operation importing the same reference; offline SerialNo remains a grouping delimiter, not an invented global identity.

Both flows bind native MySQL header/line digests, actual source prices/refunds and immutable stage/receipt IDs. A mismatch in original tender, source price override, unsupported benefits/membership provenance or native state is refused or frozen according to whether financial work is proved absent. Source `Tax18 → 1` parsing remains in the plan; no replacement tax formula is selected. The approved per-HP refund allocation descriptor is required. Source global-cart persistence is not an isolation mechanism: the private receiver uses an empty in-memory import cart and never clears the cashier/customer cart.

Latest day close is locked under the Store row, marked STALE once for the dated import, and linked to a retained impact. Its frozen cash/count fields and older close versions are preserved. Completed receipts retain their original business date and funds after later legitimate order/refund/contact/status changes. Missing native identity/evidence fails closed.

## Verification boundary

The core’s 12 isolated MySQL cases cover dated cash, pending Shopify, 20 same-operation contenders, original-only lost-reply recovery, missing confirmation proof, late SQL rollback, signed no-effects rejection, bound approval/latest-close preservation, actor revocation and immutable completion replay. The injected source transport is synthetic provider I/O; those checks do not alone certify deployment of the private receiver. Execute the dedicated source/native/Go qualification follow-up before selecting any flag. Legacy funding/backfill, unsupported source membership/benefit profiles, source defaults/pricelist anomalies, actual broker durability, downstream consumer acceptance, legal invoice handling and cooperating legacy writer deployment remain explicit gates.

Run from `backend`:

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test node node_modules/vitest/vitest.mjs run tests/legacy-import-financial/adapter.mysql.test.ts
node node_modules/typescript/bin/tsc -p tools/legacy-import-financial/tsconfig.json
```

Use the pinned Node24 runtime. The fixture creates and drops a fresh localhost-only schema and uses synthetic records only.

The server exposes latest/exact-command approval reads and explicit approval creation
under `/api/v1/admin/order-imports/:jobId/orders/:operationId/approvals`. It derives
actor, store, counter, original plan and plan hash from the owned encrypted job;
the browser supplies only an immutable command UUID and a closed reason code.
Strict validation and current sessions surround the operation. An exact grant
remains readable after the coordinator starts the order. Approval UI and shared
mutation fences are still being integrated.

Approval responses include an allowlisted original-date/currency/line-value and
product-ID/quantity/unit-price review. Customer references, contact/address data,
notes, CSV/source row fragments and private privileges never enter this response.
The durable coordinator reuses the initiating request/operator identifiers in
its asynchronous financial trace. Native integration executes the real adapter
through that coordinator and verifies completion plus original request correlation;
source transport in this check remains synthetic and is identified as such.

Run `npm run worker:order-imports` for the separately selected processor. Disabled
and demo startup perform no database or financial I/O. Enabled startup requires
the qualified financial/source/stock/schema configuration, uses the ordinary
transaction-scoped stock projection, and logs only closed resource/request/actor
metadata. Shutdown stops new claims and awaits the current operation before closing
pools. The actual private receiver, source effects and shared-writer cooperation
remain required acceptance evidence.
