# Source no-order outcomes for dispatched screening commands

This candidate closes a previously explicit code gap for the authenticated Node
POS origin. It does not select a production writer contract or certify source
feature parity. It does not extend website/customer/system origin authority,
ticket membership/gift issuance, or benefit-aware abandonment.

The immutable API source remains `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`,
including the existing approved per-HP refund patch. The unchanged literal
PosOrder/constructors/HP/marker/refund code executes in the controlled native
fixture. No TypeScript price, tax, stock or refund calculation was added.

## Receipt and race boundary

`negative.py` writes `pos-node-screening-no-order-v1` into the append-only
`pos_rewrite_public_screening_negatives` ledger. The purpose HMAC covers the
exact original capability (including operation nonce, checkout/version,
operator/epoch, customer contact binding, store/counter, quote/request hashes
and original expiry), independently verified native intent/dispatch hashes,
pinned source descriptors, a bounded static rejection code, timestamp, and
literal `noOrder: true` / `noFinancialEffects: true`. No capability header,
customer JWT, personal contact, cart or provider response is retained here.

The selected source frame retains actor/epoch → Store → counter/assignment →
check-in → checkout → original operation → customer locks in its owned READ
COMMITTED transaction. Original source writes occur inside a savepoint. An
explicit whitelisted native business denial rolls those writes back, verifies
absence, inserts the tombstone and commits without releasing the outer creation
locks. Unexpected source/driver/SQL/commit failures produce no negative proof.
Physical Connection.commit is guarded, including with an open savepoint; normal
RELEASE SAVEPOINT remains allowed. The shared guard invalidates a refused
connection so pooled work cannot leak an uncommitted order.

The same source boundary checks the tombstone before executing a delayed
original creation. An explicit expired closure also acquires those locks and
rechecks the original current actor/epoch/contact/store/counter/checkout scope.
If creation commits first, its creation/effects/reservation evidence prevents
the negative. If closure commits first, every delayed original sender is
fenced. A clock expiry, HTTP 404/2xx, missing row or transport error alone never
establishes the no-order fact.

The absence check refuses any causal creation, reservation, source effects,
completion, abandonment, payment evidence or publication journal; any original
checkout result, order/consent/confirmation identity; a matching financial
attempt/outbox; and accepted local cash for the original draft. The qualified
creation frame's atomic order/HP/benefit/provenance/effects transaction is a
required part of this proof: uncooperative writers or escaped source SQL do not
become authorized by an absent receipt. There is no scan of unrelated customer
orders and no inference from mutable paid/order status. A later contradictory
native journal blocks Node closure.

## Private transport and Node API

The private mTLS service can compose `negative_resource.private_application`
around its existing application. Its exact resources are:

```
POST /internal/pos/public-screening/no-order-receipts {operationId}
GET  /internal/pos/public-screening/no-order-receipts/:operationId
```

They use a distinct confidential `X-POS-Public-Screening-Negative-Key`; no
credentials are placed in URLs. GET never creates a receipt. POST refuses an
unexpired command and is idempotent for an existing immutable negative. A
retained proof can be read after original actor/contact/config changes; that
read cannot authorize a new source or financial action. Unknown exceptions
yield static codes. Logs contain only resource/module/event ID/request ID and
verified actor ID; no payload, key, header, contacts or exception text.

The existing authenticated Node `POST .../screening-admissions/:operationId/closures`
first looks for a verified native proof. Only an explicit missing-proof closure
may call the selected private resource, outside every SQL transaction. It then
re-reads the native receipt and verifies its HMAC, original intent/dispatch,
scope and absence predicates. The HTTP response never substitutes for that
native proof. Both before and after the await, current session and native
store/counter/check-in/owner checks remain mandatory.

Closure atomically records `closed-no-order`, rejects the original checkout
operation, and returns the original checkout to `quoted`. Cart, quote, draft
identity and audit remain. It creates no Order, payment, stock, cash, refund,
clearance or printing record. Source rejection is exposed as `source-rejected`
until this explicit native closure. Existing truly unsent admissions retain
the separate `closed-unsent` behavior.

The cashier UI saves only the original scoped closure intent before POST. A
lost reply/reload uses GET only. If closure remains unresolved, a user can
explicitly retry the same nonce's closure; it never resends creation/payment.
Storage corruption/failure, offline mode and actor changes block dispatch.

## Integration checklist (default off)

- Register `src/modules/checkout/screening-writer/negative-migration.sql` in the
  deterministic migration plan/Docker SQL copy. New full source installations
  also get the same table from `migration.review.sql`. No live DDL was applied.
- The public source generator/manifest includes `negative.py` and
  `negative_resource.py`, plus the shared physical-commit guard checksum.
- Before private runtime DB/bootstrap, call
  `negative_resource.options(env, proof, (importKey, customerContextKey, publicationKey))`.
  If selected or a read key is retained, compose
  `private_application(resource(factory, proof), opts['key'], emit_stream, application, opts['allowPost'])`.
  Common private runtime ownership remains with its owner; this slice supplies
  the executable resource and native WSGI proof tests.
- Source selection: `POS_PUBLIC_SCREENING_NEGATIVE_CONTRACT=pos-node-screening-negative-resource-v1`
  and independent `POS_PUBLIC_SCREENING_NEGATIVE_KEY`. With only the retained
  key, GET is available and new POST remains disabled.
- Node options already parse `UPSTREAM_POS_PUBLIC_SCREENING_NEGATIVE_CONTRACT`
  with that same literal, `TSS_POS_PUBLIC_SCREENING_NEGATIVE_KEY`, and
  `TSS_POS_PUBLIC_SCREENING_NEGATIVE_URL` ending exactly in the private resource
  path above. Only HTTPS, no credentials/query/fragment, no redirects, bounded
  response bytes and a 10-second timeout are accepted. Native sealed-proof
  recovery still works with the transport disabled.
- Keep all existing public origin/schema/all-writer/source/model qualifications
  unselected until the actual bundle, private HTTPS ingress, independent keys,
  migrations and collaborating writers have been accepted.

## Focused evidence

`tests/public-screening-writer/negative.mysql.test.ts` executes actual pinned
source stock rejection and late expiry after original writes, actual private
WSGI requests and native Node/Fastify closure. It covers both race winners,
20 concurrent closures, lost acknowledgment, expiry, revocation during the
await, current actor/contact/check-in changes, unknown rollback, escaped
physical COMMIT, tampered/oversized proof/intent/dispatch, contradictory
financial evidence, GET/default-off behavior and false 404/timeout/2xx claims.
All fixture DBs are disposable localhost UUID schemas; no source data is read.
The existing actual Go bridge remains a separate positive-order qualification;
this no-order closure invokes no Go/payment/provider endpoint.

`test_negative.py` checks the private request boundary and static privacy-safe
failure logging. The real Chromium recovery component covers lost closure
reply/reload, explicit same-nonce retry and corrupt/unwritable storage in
addition to existing actor/offline and paid-read cases. This is bounded local
evidence, not production deployment or a new release-ledger certification.

```
POS_LEGACY_IMPORT_SOURCE_ROOT=<immutable-2960-source> SCREENING_SOURCE_ROOT=<same> \
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run tests/public-screening-writer --maxWorkers=1
POS_LEGACY_IMPORT_SOURCE_ROOT=<immutable-2960-source> \
  compatibility/upstream/offline-cash-pricing/.venv/bin/python -B -m unittest discover -s tests/public-screening-writer -p 'test_*.py'
npx --offline node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tools/public-screening-writer/tsconfig.json
```

From frontend, `ADMINISTRATION_BROWSER_TESTS=true` plus
`vitest run tests/screening-writer/recovery.browser.test.ts --maxWorkers=1`
uses its own ephemeral loopback Vite server, not shared dist/default ports.

Checked handoff: 78 TypeScript/native cases across 13 files pass; the two
existing Go-binary cases are explicitly skipped in this invocation. Eleven
Python checks and six real Chromium recovery cases pass, along with backend
and frontend scoped strict/lint, generated artifacts and a fresh Node ESM
module import. The 23 new native cases exercise no-order behavior and invoke
no Go/payment/provider action.

## Merged integration

Root integration `ff34bf5` registers the additive negative migration without
changing the existing source-migration checksum. The shared private factory
validates its separate key before database/source construction and mounts the
GET-only retained-key or explicitly selected POST resource. Native dependencies
load after option validation. Three factory tests exercise those actual mount
paths; the full public native/Go run passes 80 cases and the recovery UI passes
six Chromium cases. These local results leave deployment/private-ingress and
all-writer acceptance unselected. See `evidence/source-preparation-negative-ff34bf5.json`.
