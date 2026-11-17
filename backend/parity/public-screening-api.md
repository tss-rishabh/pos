# Public screening Node API and recovery integration

This follow-up implements the actual ordinary Node checkout/payment/worker path
for the reviewed `pos-node-screening-writer-v1` candidate. Flags remain
unselected. It does not certify an upstream deployment or all source writers.
The source protocol remains the separate `34d11d8` handoff, with unchanged
ordinary request bytes when no screening admission is selected.

## Submission and native completion

`registerCheckout` builds the pure `publicScreeningCoordinator` and supplies its
ports to the ordinary service, gateway, finalizer and payment repository. No
constructor performs SQL, DDL, network I/O or source dispatch. A ticket submit
requires a retained final quote and normal current customer/context, consent,
refund and projection prerequisites. The internal issuer reads the native busy
UUID, actor version/epoch, current contact and quote. Native admission and the
original submission checkpoint are durable before the private header goes only
to `pos/order`. The gateway validates exact payload/customer scope and requires
the public source marker. No capability, key, contact binding or raw quote is
returned by the recovery API. The selected payload supplies the exact source
method ID (coc14/zero-prepaid3) before hashing: pinned
`MetaInitializers.make_payment_details` mutates that same dictionary to the
native ID before validation. A changed lookup fails the exact hash. Unselected
ordinary payloads remain byte unchanged; the source hash is not relaxed.

The source receipt is independently authenticated before normal confirmation.
Payment work owns READ COMMITTED and the existing actor → epoch → Store →
counter/assignment → check-in → checkout → global customer → Order prefix.
Native session checks reuse the same transaction after that authority prefix,
using the shared optional-TX auth binder (`4ba22d7`), and lock the real session
row through commit. Hints are current nonlocking reads in the same owned transaction; they do not
borrow another pool connection while holding Store. There is no retry loop that
masks an inverse lock order. Non-ticket ordinary wire fields remain absent.

At the actual paid writer, native payment begin records an authenticated exact
original input/request binding. Completion rereads the actual immutable paid
attempt, exact cash/online/received split and transaction, terminal completion
audit when applicable, native OrderStore/customer/counter/method/status, and the
full ordinary projection/HP proof. The signed paid evidence, completion HMAC and
shared POS COUNTED transition commit with that payment. A late failure rolls
back all settlement/COUNTED writes.

Zero-pay method3 instead requires its actual zero header, complete native paid
projection and absence of a payment attempt. Its existing original submission
UUID is the receipt reference. No cash receipt, provider payment or received
money is invented. Method14 stays pending until a genuine settlement. Neither
current paid flags nor an HTTP200 can authenticate completion.

## Original reply retention

If current authority or an integrity proof changes during a provider call, a
private in-memory branded dispatch frame binds the actual original
attempt/busy/order/store/counter/actor/provider/channel/machine/INR/amounts. A
separate native transaction may retain that factual reply even after actor
revocation. It appends a purpose-authenticated immutable fact and leaves the
attempt uncertain; it cannot settle an order, change stock or advance COUNTED.
Public JSON cannot supply or clone this dispatch frame.

Current authority is mandatory for later settlement. GET exposes the original
uncertain attempt without another provider call. Explicit reconciliation can
consume a definitive authenticated retained reply locally, recheck all native
proofs and append the genuine original terminal audit. It does not repeat the
charge or manufacture a principal. Native validation errors remain errors; they
are not replaced by a fabricated uncertain provider observation. The original
private definitive fact survives them. Provider payloads/credentials are not
stored; only bounded reviewed decision/reference and nonsecret audit identifiers
are retained. The money already collected remains visible for reconciliation.

## API and cashier recovery

All resources use the original store/checkout/submission operation:

```
GET  /api/v1/stores/:storeId/checkout-sessions/:checkoutId/screening-admissions/:operationId
POST .../:operationId/reconciliations {}
POST .../:operationId/closures {}
POST .../:operationId/abandonments {commandId,reason}
```

Every response checks the actual current session again after awaits. Reads
require the current owner or a current authorized internal manager and matching
native store/counter/check-in. A missing session validator fails closed.
Completed reads need the retained source proof key, not new-admission selection
or the customer-context signing key.

A lost source reply can reveal/adopt only its authentic original native order
identity. Adoption fences the old callback and does not call source creation,
confirmation, payment or stock. The original no-confirmation state is explicit.
A current internal manager can fence an exactly proved pending0 zero-benefit
order through the existing immutable abandonment command. Any projection,
payment/provider attempt, cash, wallet/GV trace, membership proof or dispatched
effect refuses abandonment. Its original Order/HP/markers remain intact. Node
also fences its delayed submission callback. Signed/offline collected cash is
never deleted, refunded or converted into a draft by this action.

Only an expired native PREPARED admission with no dispatch checkpoint, source
order or reservation can close as unsent. It atomically fences the original busy
operation/version. Absence/404 after a dispatch, timeout or missing source reply
never proves no effect and never releases quota. No source call is retried by a
GET. A new UI child mounts only for `screeningAdmission`; opaque action IDs are
saved before a POST, reload/status checks are GET-only and a failed parent
refresh retains the confirmed result. This child never clears a local cart,
creates a receipt or triggers printing.

## Real post-completion delivery

The existing financial-outbox worker now drains
`publicScreeningPublicationWorker`. Only native sealed completion+COUNTED can
claim publication. An immutable dispatch row is committed before the sole POST;
all later worker attempts use GET for that same operation. SQL locks are
released before HTTP. Responses are byte-bounded, purpose-HMAC checked and bound
to original creation/completion/effects hashes. Terminal accepted/cancelled
receipts cannot be downgraded. The source resource independently checks its
sealed exact effect intents/jobs before signing acceptance; queue acceptance is
not remote delivery success. Unknown/processing source publication never
resends.

Actual source resources are supplied by the administration runtime slice:
`compatibility/upstream/public-screening-writer/publication_resource.py`, mounted
by the private source runtime factory. It uses POST
`/internal/pos/public-screening/publications` and GET of `/:operationId`, separate
purpose key and the exact `{data,proofHash}` response. GET routes no task. A
newly disabled admission/resource selector still permits original GET recovery
when retained transport/key material is available. Missing verification keys
fail closed rather than fabricating a receipt.

## Root registration

- Register `checkout/screening-writer/migration.sql` after the existing checkout,
  shared reservation and public source/shared ledgers.
- Register `checkout/payments/provider-evidence-migration.sql` after0003 payments.
- The four CREATE-only `pos_rewrite_*` definitions in
  `compatibility/upstream/public-screening-writer/migration.review.sql` are byte
  identical to the source protocol prerequisite; root owns their explicit
  reviewed migration/Docker registration. No legacy alteration is added here.
- `registerCheckout` and `checkout/worker.ts` contain the real runtime hooks.
  The optional CheckoutReview mount and schema preserve absent ordinary fields.
- Add frontend strict config `frontend/tests/screening-writer/tsconfig.json` and
  browser `frontend/tests/screening-writer/recovery.browser.test.ts` to the
  verifier. Existing backend strict config includes all new tests. The optional-TX Fastify
  auth binder/signature from `4ba22d7` is a runtime dependency; no-argument
  callers remain compatible.

Optional Node environment (blank/unselected defaults):

```
UPSTREAM_POS_NODE_SCREENING_WRITER_CONTRACT=pos-node-screening-writer-v1
TSS_POS_LEGACY_IMPORT_PROOF_KEY=<independent retained source proof key>
TSS_POS_PUBLIC_SCREENING_PUBLICATION_URL=https://private-host/internal/pos/public-screening/publications
TSS_POS_PUBLIC_SCREENING_PUBLICATION_KEY=<separate purpose transport key>
UPSTREAM_POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT=pos-node-screening-publication-resource-v1
```

Admission reuses existing `TSS_POS_CUSTOMER_CONTEXT_KEY` with its disjoint
purpose/domain. The source resource selector is
`POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT=pos-node-screening-publication-resource-v1`
and source transport key is `POS_PUBLIC_SCREENING_PUBLICATION_KEY`. Its signed
response contract is separately `pos-node-screening-publication-v1`.

## Evidence and remaining scope

New tests exercise actual checkout API→native issuer→literal pinned PosOrder→
confirmation proof→pending result, exact replay,20 payment contenders, source
reply loss, missing/tampered proof rollback, zero-pay without a cash attempt,
unsent closure/delayed source denial, abandonment and after-await revocation.
The focused source runner supplies the actual Go binary for the same native API
scenarios; without that binary the explicitly labeled fixture builds native
projection rows only. Existing Go/source cases are retained unchanged.

The cross-boundary publication test takes a genuine Node-paid receipt through
the actual WSGI resource and synthetic durable broker, loses its accepted HTTP
reply and checks the original receipt by GET with zero new queue calls. It uses
`tools/source-runtime-acceptance/publication_native_driver.py` from peer runtime commit `79a9a7126a8110d6f7efdfcf4791a008c4fe8294` (or `POS_PUBLIC_SCREENING_PUBLICATION_DRIVER` override while
worktrees are separate). A real mysqlSessions20-contender case proves same-TX session reads avoid pool
starvation and native revocation hides a retained completion. Three Chromium flows prove saved-action reload,
operator/offline fencing and completed reads with no payment/print callback.
No real provider, broker, production database, upload or deployment was invoked.

Remaining CODE: website/customer/system origins and their original auth/nonce
protocols; ticket+new/upgrade/automatic-free membership or gift issuance
composition; benefit-aware abandonment; a proved negative receipt for an
already-dispatched source command that created no order. The conservative Node
preflight rejects unsupported variants before dispatch. The public protocol
continues to gate unpatched writer participation. Historical pre-proof funding
requires explicit reconciliation. A cashier's original local draft is retained
after abandonment; this component supplies no fabricated paid/clearance proof
or forced local deletion. Combined source runtime/schema/model patches, every
participating writer and deployment/broker/private HTTPS acceptance remain
external release gates. Those gates are distinct from the implemented Node
API/final-writer/worker code.

Final scoped handoff:57 TypeScript/native cases across12 files pass with the
actual Go bridge binary, immutable source override and peer WSGI driver enabled;
113 existing checkout service/payment/routes/native regressions and3 Chromium
recovery flows pass. Backend/frontend owned strict and lint checks pass. These
counts describe local disposable/synthetic-I/O acceptance, not production
certification. The separate peer resource dependency is79a9a712; the shared auth
binder dependency is4ba22d7 (locally cherry-picked as b7fd3dd).

Reproduce with the immutable source root and isolated MySQL URL set:

```
sh compatibility/upstream/public-screening-writer/run-native-tests.sh
npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout/mysql.integration.test.ts tests/checkout/payments.test.ts tests/checkout/service.test.ts tests/checkout/routes.test.ts --maxWorkers=1
npx --offline node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tools/public-screening-writer/tsconfig.json
```

The source runtime driver is discovered at its normal repository path after the
peer commit is merged. For isolated worktrees set
`POS_PUBLIC_SCREENING_PUBLICATION_DRIVER` to that committed driver's path. In
frontend, run the new browser file with `ADMINISTRATION_BROWSER_TESTS=true` and
the new strict config; it starts/stops an ephemeral Vite port and independent
cache, never a shared production build.
