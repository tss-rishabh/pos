# Current manager authority for an existing CSV order

Implementation handoff, pending final validation. The user requires feature and
integration code before further test/parity runs. Existing tests and acceptance
criteria are preserved; this tranche adds no test expansion and runs no validation
suite or live provider/SQL/deployment action.

The original scope actor, customer ID, order, namespace, reference, plan/request
HMAC, source receipts and consumed benefits remain unchanged. The original actor
is never synthesized as a current principal. A new append-only authenticated
manager delegation authorizes only future discretionary stages of that same order.
It cannot create a replacement order, change historical tender/prices, reuse a
coupon, or label a provider charge refunded/paid.

## Native protocol

`authority-succession/` defines grants, a current head, append-only per-grant stage
claims and immutable original continuation-command identities. A grant binds the
original scope/request/plan/authority digest, native source order/header/line
receipt, a reviewed native stage-evidence digest, current manager, real current
actor epoch/version, current active/unblocked/undisabled customer/contact revision,
current period/close snapshot and authenticated manager session hash/digest. The native grant retains its session ID only inside the ledger; no session ID or credential is sent to the browser or source capability. Python/Go require that exact approved native session to remain active for new actions. Its source
HMAC is separate from its financial-record HMAC. Grants last one hour and form a
bounded chain. A new grant fences older actor/delegation capabilities under the
same native operation lock.

The additive state head is independently authenticated by the native ledger. It
is excluded from the original request-HMAC inputs; all original identity/HMAC
bytes remain unchanged. New stage and settlement guards read the actual native
head even when the new-grant feature is unselected, so removing a mutable state
marker or disabling configuration cannot silently reopen the original actor.
The new four-table migration is mandatory for those native guards.

All manager work uses current actor/epoch → Store → assignment/counter/check-in →
original operation → global customer → native Order. Private profile reads reuse
an internal transaction scope witness. They never acquire the old actor after
Store, which would invert against archive/revocation. Manager lookup uses original
job/operation references and current native store/counter/check-in/session access;
it does not relax the existing upload-owner rules elsewhere.

Positive original Go/order/settlement/publication receipts are authenticated as
past facts. Missing mutable paid flags, HTTP200, equal quantities or absent receipts
are never proof of a financial outcome. A positive original Go receipt repairs only
its acknowledgment metadata, retaining its original nonce and proof.

The explicit continuation command claims once. New or adopted future confirmation,
local settlement and publication retain the **original stage nonce**. A delayed
old private Go/source request is rejected by the newer native head/claim before
mutation. Native settlement and its proof commit atomically; it audits the actual
current manager, while the immutable original scope remains original. Unknown
ordinary provider attempts are refused. Broker effects already processing or
uncertain cannot be redispatched or released by manager approval; they require
genuine original outcome evidence.

GET performs only retained receipt/factual reconciliation. It never starts an
unstarted stage. An exact continuation POST replay returns its saved outcome and
does not execute again. If authority is revoked while a remote call is outstanding,
original factual receipts/continuation outcomes are retained without granting
permission for another settlement or publication. A later explicit manager grant
may fence delayed native work; it never chooses another order or payment nonce.

## Private source and Go integration

New `authority_succession.py` verifies the optional envelope and native head/claim;
`native.py`, `protocol.py`, `receiver.py`, `http_app.py` and the owned lock prelude
use it. Confirmation/publication capabilities may contain the optional signed
succession envelope; order/preparation capabilities cannot. The original body
scope/authority stay original. The effective manager is selected before actor/
epoch/Store locks; current contact and active customer are rechecked. Publication
checks current authority before claiming effects, while recording an actual
post-dispatch acknowledgment remains a retained-evidence operation.

New `legacy_import_succession.go` implements the same native envelope/head/claim
checks. Two private-only `screening.go` prelude hooks choose the current actor
before Store and recheck the native delegation after operation lock. Original
`p.actor`, public screening counter behavior, native order/customer association and
ordinary capability bytes remain unchanged. Original source/Go protocols with no
succession retain field absence; no default null/empty delegation is injected.
The private Node/source/Go selection contract is
`pos-import-authority-succession-v1`.

Completion embeds authenticated grant/claim snapshots and identifies which grant
actually applied to each stage. Existing original confirmation/settlement can
remain attributed to the old actor when they predate delegation. New confirmation,
settlement and publication proofs carry the actual optional delegation reference.
After the outer financial completion seal is authenticated, immutable recovery
needs no current actor/contact, source keys, profile flags or manager session.

## Runnable API and UI

`ImportFinancialAdapter.authoritySuccession` is the server-only port. Root mounts
`registerLegacyImportAuthoritySuccession(app,{service})` from
`authority-succession/routes.ts`. It rechecks current sessions after awaited work.
No scope, actor ID or native authority is supplied by a browser body.

Base `/api/v1/admin/order-imports/:jobId/orders/:operationId/authority-successions`:

- GET: current scoped review.
- POST `{commandId,reviewHash,reason}`: append an explicitly reviewed grant.
- GET `/:commandId`: recover that exact original approval, including a lost reply.
- POST `/continuations` `{commandId,grantId}`: claim remaining original work once.
- GET `/continuations/:commandId`: recover the original continuation; never resend.

The actual administration imports page mounts `ImportAuthorityRecovery`, including
standalone original job/operation lookup for another/archived upload owner. The
current manager must check in to the original store/counter. It captures actor
scope, saves opaque action references before dispatch under browser coordination,
retains unknown actions for GET recovery, keeps multiple references during explicit
new authority review, blocks same-grant continuation replay and preserves completed
proofs when presentation refresh fails. Saved references alone confer no authority.
No contact data, source capability, credentials or money payload is stored locally.

Root owns common runtime/registrar wiring, migration registry, Docker/env/package
and common source generators. This branch owns the port, API, UI mount and private
protocol implementation. Environment selectors:

- Node `LEGACY_ORDER_IMPORT_AUTHORITY_SUCCESSION_CONTRACT`.
- Source/Go `POS_LEGACY_IMPORT_AUTHORITY_SUCCESSION_CONTRACT`.

Both select `pos-import-authority-succession-v1`. No new signing secret is reused
as a different authority: existing purpose-separated financial/source keys sign
separate domains. Retained financial keys remain required for immutable reads;
source keys remain required until first complete sealing.

Migration: `src/modules/legacy-order-imports/authority-succession/migration.sql`.
Common source generator must copy `legacy_import_succession.go` and fingerprint
`authority_succession.py` plus the changed private integration files. Scoped strict
registration is `tools/legacy-import-succession/tsconfig.json`, for the later
validation phase. All source repository siblings remain read-only.

## Scope still protected in the base handoff

Actor succession, phone/contact revision succession and ordinary customer email
succession are implemented. The follow-up `membership-profile/references.ts`
authenticates an **already activated offline** entitlement from its original Go
confirmation, original native projection, signed staged descriptor and activated
per-order provenance. It verifies the existing contact transaction's authenticated
encrypted input/effects and successful immutable commit receipt. The current EAV
member value, expiry, active bits and creation timestamps must match the original
activation; only the reference/hash and the exact contact-copy update timestamp
may differ. No membership row, expiry or prior provenance is mutated.

Explicit manager approval appends a source-authenticated reference attestation in
`pos_rewrite_import_membership_references` in that same transaction. The financial
completion seal embeds it. The source `membership_reference.py` reader checks
its native grant, exact retained contact records, original confirmation and
unchanged current entitlement before the existing once-only cache invalidation.
It receives no contact-decryption key. Current contact/evidence changes still
refuse new work; existing immutable completed results remain independently readable.
The existing contact pruner expires only uncommitted verification challenges and
clears only OTP payloads. Committed/uncertain encrypted challenge input, permanent
successful mutation receipts and encrypted source-effects payloads remain retained
by the existing prune/worker paths. Reference recovery does not require expired
OTP codes or an unexpired challenge; no new PII retention exception is added.

The selector is `POS_LEGACY_IMPORT_MEMBERSHIP_REFERENCE_CONTRACT` with literal
`pos-csv-membership-contact-reference-v1`. Node additionally uses the existing
`CUSTOMER_CONTACTS_SECRET` and `BUSINESS_TIMEZONE` only for private reference
verification. Source uses its existing source-proof, source-auth and membership
keys under distinct purposes; it never receives the contact secret. The additive
migration is `membership-profile/reference-migration.sql`; it creates one
append-only proof table and a bounded customer/kind/status index on the rewrite
contact-challenge table. Common source packaging must include
`membership_reference.py` and fingerprint the changed cache consumer.

The staged successor follow-up implements changed-email **before** activation.
Explicit manager approval calls `captureStagedReferences` and appends
`pos_rewrite_import_membership_staged_references` in the same grant transaction.
Its source HMAC binds the original signed staged record, exact contact commit,
current native EAV/revision and unchanged pending activation bits. The original
source receipt and native staged provenance are not rewritten by approval.

The private Go wrapper locks and checks that descriptor at the original
confirmation nonce. Its in-memory activation view uses the proved current email
reference and native revision, retaining original before-entitlement, operation,
creation time and staged expiry. The existing source Apply executes once. The
activation finalizer CASes the original staged seal to the actual activated
provenance and records `member-reference` in the same SQL transaction as original
confirmation/projection. Its transition binds original stage, approved reference,
actual activated seal, confirmation hash/nonce and explicit source mutation.

Pinned payments commit `434f3e438d1cb48c64e5723222c6efda506db571`,
`juspay/model.go:2355–2361`, activates new/free memberships by setting both active
bits. The separate upgrade branch at `2378–2425` adds the source's **second** expiry
delta and changes the member value; `getExpiryDelta` at `1994–2016` uses the actual
365/330/270 environment mapping, returning zero for a missing key. This follow-up
preserves those source branches. It freezes their selected delta before Apply,
checks actual after-values, and seals the branch/delta/expiry before/after. It
never selects a corrected upgrade duration or extends value merely because a
contact changed. Unaligned/ambiguous source product settings fail before Apply.

Shopify uses the signed staged-reference snapshot for its original pending
settlement/publication. It never enters Go activation, acquires a confirmation or
paid receipt, or flips activation bits. Node/source cache readers recognize the
actual staged or activated transition; completed financial/cache acknowledgments
are retained facts and do not require current EAV/contact/session/profile settings
or another cache invalidation. Unknown processing remains quarantined.

Additional selector:
`POS_LEGACY_IMPORT_MEMBERSHIP_STAGED_REFERENCE_CONTRACT=pos-csv-membership-staged-reference-v1`.
Additional migration: `membership-profile/staged-reference-migration.sql`.
Additional source helper: `membership_staged_reference.py`.
Additional Go helper: `legacy_import_membership_reference.go`.
Root's common generator replaces only the existing new-confirmation
`lockMembership`/`finishMembership` pair with these wrappers and copies/hashes that
helper. A nil/no-reference ordinary path delegates unchanged. Existing public
membership and source-frame ownership are untouched.

Unproved legacy contact transfers or arbitrary direct account/EAV edits remain
explicit reconciliation boundaries. These proofs do not invent missing historical
activation or move/regrant an entity. All source contracts remain unselected until
the later source/native/race/security validation and deployment acceptance phase.

Pending final validation includes source/native race and delayed-request fencing,
rollback, current session/actor/contact/check-in revocation, lost replies, original
benefit/stock conservation, UI recovery and all default-byte compatibility checks.
No passing certification is claimed for this implementation handoff.
