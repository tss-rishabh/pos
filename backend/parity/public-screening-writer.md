# Node POS screening writer candidate

This is an unselected, reviewable Node-origin protocol. It is not an all-writer
certification or a paid receipt. No protected repository, deployed service,
provider, production schema or live row was changed.

The source is API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`.
`PosOrder.on_post` at `controllers/OrderController.py:10870` checks the sum of
requested ticket quantity at 10922–10933 and creates one screening marker for
each generated HP at 11050. `Order.on_post` has its own equivalent check and
marker creation. The helper at `libs/OrderHelper.py:203` catches count errors and
returns zero; the candidate instead requires an independently successful native
count. The original repeated `session.commit()` calls become flushes inside one
owned transaction for selected Node requests.

## Native counter and admitted scope

The exact count is marker-first `idx_user_id` → Order PK → HP PK, using
`s.user_id`, `hp.prod_id=390238`, and `orders.order_status NOT IN(0,17)`.
Duplicates count; NULL/0/17 do not. Status4 and6 continue counting. There is no
payment/store/Order-owner/HP-owner predicate and no SUM(qty). Quantity mode can
therefore preserve the literal three-unit/two-marker behavior. Verified physical
indexes/types are in `evidence/mysql-screening-schema.json`.

The shared reservation origin now accepts `pos` as well as `offline`/`shopify`.
Old row shapes and HMAC bytes do not change. CSV commands still check their own
literal plan kind, financial operation, authority and source receipt. A public
POS order is never fabricated as a CSV operation. Its pending0 order retains
BOUND credit until native eligible markers cover the count; Go never releases
it or invents a final payment seal.

## Root integration hooks

New server helper:

```
nodeScreeningWriterIssuer({db,environment,checkins,authSessionValid,clock?})
  .issue(user,{storeId,checkoutId,operationId},orderPayload)
  -> {header,value}
```

The mandatory session validator runs before and after awaits. The helper loads
the current persisted checkout, exact inflight/busy UUID, actor version/epoch
and native contact revision/digest. It signs the retained quote and exact server
payload, never a browser-supplied actor, price, date or skip ID. The canonical
writer prefix is actor → epoch → Store UPDATE → assignment/counter → check-in
→ checkout → customer. Counter hints are outside the transaction and rechecked.

Use `nodeScreeningWriterHeader` (`X-POS-Screening-Writer`) only for the existing
`pos/order` request. The capability lasts 60 seconds, binds the operation, and derives a
disjoint key/domain from existing `CheckoutEnvironment.customerContextKey` /
`TSS_POS_CUSTOMER_CONTEXT_KEY`. Source reads the existing
`middleware.PosCustomerContext.KEY_ENVIRONMENT`; no guessed key alias is used.
Customer JWT, fresh customer/membership context, spending OTP/consent, refund
allocation and ordinary projection contracts remain independently mandatory.

`readPublicScreeningCreation(tx,operationId,sourceProofKey)` reads and verifies
the separate original native creation record. Its caller must enforce current
read access and check the session again after awaits. It is not payment
evidence. Lost responses retain the original UUID and use GET reconciliation;
neither an HTTP 200, matching quantity nor a mutable paid flag establishes
completion. There is no root service/gateway/API wiring in this commit.

The source frame verifies the capability before SQL hints, owns RC, rechecks
current actor/store/franchise assignment/counter/check-in/checkout/contact, and
locks the global customer before Order/HP/reservation work. Source Session,
SessionR, SessionC, SessionReadCMS and WriteDbConn.Session route to that frame.
Scoped-session remove/close detection is preserved outside it. Shared cart
persistence is suppressed, eight source Redis aliases cannot write/script/
pipeline, tasks are captured and financial HTTP is refused. No shared guest cart
is cleared. After the original ValidateCheckout, the literal ProcessOrder
serialization/GST block is compiled from pinned bytes and compared with the
retained quote. Native stock rows are retained through source staging.

Creation + original HP/markers + BOUND reservation + encrypted original effect
intents commit together. The source proof key is independent of the admission
key. The generated public patch retains the source authentication decorator and
composes the separately approved per-HP refund correction. Zero-pay POS is
source method 3; online PREPAID is 7 and ordinary positive POS is method 14.

## Explicit unpaid abandonment

```
publicScreeningAbandonment({config,db,proofKey,checkins,authSessionValid,clock?})
  .abandon(user,{operationId,sourceOperationId,storeId,counterId,reason})
  .read(user,{operationId,sourceOperationId,storeId,counterId})
```

This current internal-manager command accepts only an authenticated original
creation record, pending0 native order, exact source structure, and zero
financial evidence. It refuses any Go projection, payment attempt/outbox, cash,
wallet/GV allocation/history, membership provenance, refunded/fulfilled line, or
dispatched source effect. The immutable tombstone, shared quota release and
cancellation of pending effects commit together. Order, HP and marker history
remain unchanged. Replays use the same command, actor, reason and original
operation. The read method validates the exact original command without another
POST. A lost source response with a committed creation record is supported.

Go checks this native tombstone under the same Store/customer/Order locks before
Apply, including after waits. A delayed confirmation cannot turn an abandoned
order into a stock/wallet operation. `assertPublicScreeningOrderAvailable` is
also exported for root's new-payment pre-dispatch boundary, with no public
operation bypass. Already collected/uncertain money is never erased or called a
refund. Any late immutable offline receipt must retain its cash and become a
manager reconciliation conflict.

Planned nonzero wallet/GV/coupon headers still refuse abandonment. The source
wallet getters at `OrderHelper.py:857–873` are read-only, but complete combined
staging/no-debit provenance has not been certified by this candidate. That
benefit-aware abandonment is CODE work. Missing creation evidence also remains
unknown: there is no never-dispatched tombstone/negative source receipt here.
Do not clear, create a new nonce, infer no-effects from 404, or release by TTL.

## Ordinary completion and source publication

`publicScreeningCompletionSchema` and `publicScreeningCompletions` define the
root final-writer seam. It must independently verify the actual immutable paid
receipt and complete ordinary projection, then atomically write its source-key
HMAC and mark the shared POS reservation COUNTED. The descriptor binds original
creation hash, operation/order/customer/store/counter, payment receipt ID,
projection hash, line hash and completion time. There is deliberately no
permissive final-writer implementation or mutable-paid fallback here.

`publicScreeningLineHash` hashes native immutable projection rows sorted by HP:
`id:productId:quantity:inputHash`, newline-separated SHA256. It serializes no
FLOAT/money. Source `public_effects.publish` requires the exact final seal,
matching native projection header/lines and encrypted effect hash. It checkpoints
processing before broker I/O, releases SQL locks before publishing, requires
durable queues/TLS/publisher confirms, and reports queue acceptance only. An
unknown or processing outcome never resends. The actual Node paid-writer and
worker/route registration are root integration CODE, still absent/unselected.

## Source artifact and schema prerequisites

`compatibility/upstream/public-screening-writer/prepare.py` generates the public
main/controller/entry overlay and manifest, against the immutable source artifact.
The running patched source and immutable base must be separate. Bootstrap
verifies the generated running main/controller hashes, base source pins and
physical columns. It composes the existing reviewed `pos-import-source-model-v1`
mapping/default corrections globally, with selected-frame sentinel normalization
only. It does not alter SQL mode. Source nullable date DDL is a separate reviewed
prerequisite. Raw source models are not called qualified. Other writers' complete
runtime/default behavior remains a cutover qualification gate.

The four tables in `migration.review.sql` are source/rewrite-owned candidate DDL
only: creation, effects, abandonment and completion. They require the existing
shared reservation schema plus current checkout/check-in/contact/projection and
financial proof prerequisites. Do not register legacy triggers or run any DDL
automatically from this artifact.

Source options, all unselected:

```
POS_NODE_SCREENING_WRITER_CONTRACT=pos-node-screening-writer-v1
POS_NODE_SCREENING_MODULE_ROOT=<reviewed compatibility/upstream bundle>
POS_LEGACY_IMPORT_SOURCE_ROOT=<immutable 2960 artifact>
POS_LEGACY_IMPORT_MODEL_CONTRACT=pos-import-source-model-v1
POS_LEGACY_IMPORT_SCREENING_CONTRACT=pos-csv-screening-2960-v1
POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT=pos-screening-schema-v1
POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT=pos-screening-all-writers-v1
```

Reuse existing source `TSS_POS_CUSTOMER_CONTEXT_KEY` and independent
`POS_LEGACY_IMPORT_PROOF_KEY`; do not log either or place them in renderer state.
Root must compose this main/controller overlay with its existing customer-context,
membership-reader and import-hold patches and regenerate merged manifests. A
standalone patch against the original source is not evidence that this combined
runtime has been deployed/accepted.

## Remaining participants and CODE

* Source `Order.on_post` website/customer orders have different auth/nonce/store
  semantics and still need their own concrete customer-origin frame.
* Legacy Django/MPos callers of `PosOrder`, customer/system/job writers and
  non-POS Go payment/status transitions are not authorized by this internal
  operator capability. Enumerate/qualify them before selecting all-writer flags.
* New/upgrade/automatic-free membership staging and gift-card issuance combined
  with a ticket explicitly refuse before Order writes. Compose the existing
  real membership producer/cache journal or gift funding proof first; these are
  CODE gaps, not missing environment variables. Existing unchanged membership
  remains eligible subject to the separate fresh-reader contract.
* Benefit-aware abandonment, never-created source cancellation, real ordinary
  paid completion/root UI recovery/worker wiring remain CODE as described above.
* Pre-proof historical ticket funding/admission needs explicit reconciliation;
  no backfilled receipt or causal success is fabricated from current rows.

## Scoped checks

Set the immutable source override explicitly and use only disposable localhost
`CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test`.

```
npx --offline node@24.22.3 node_modules/typescript/bin/tsc -p tools/public-screening-writer/tsconfig.json --pretty false
<locked-python> -B -m unittest discover -s tests/public-screening-writer -p 'test_*.py'
sh compatibility/upstream/public-screening-writer/run-native-tests.sh
sh compatibility/upstream/legacy-order-imports/run-go-tests.sh '^TestScreening'
```

The source fixture executes the pinned PosOrder/constructors/HP/markers/refund
body with synthetic catalog/validation/provider I/O; it does not import source
main or claim a full real-dependency Falcon runtime. Native source barriers prove
two customers reach their original bodies before either order/receipt is
visible. Native Go tests exercise original Apply, cross-store locks, non-ticket
wallet cancellation, HMAC/structure refusal, delayed abandonment and replay.
Completion/effect fixtures are explicitly protocol seals, not production-paid
certification. No shared frontend build/server or default browser port is used.

Scoped evidence at handoff: 36 cases across the five TypeScript test files,
seven Python frame/model checks, and 17 Go screening tests (39 named cases with
subtests) under the race detector pass. The final recovery/publication deltas
were rechecked with the 16 authority/effect and 14 source/effect cases; scoped
TypeScript, ESLint and both generated artifact checks pass.
