# Screening writer-origin implementation

This is a code integration checkpoint, **pending final validation**. No selector
is activated by this change. It does not certify source parity or deployment.

The original source participants are API-v2 `Order.on_post`, legacy
`PosOrder.on_post` callers, CSK `controllers.external.OrderPlacement.place_order`,
and the independent payments application's customer/provider/system writers.
API source is pinned to `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`; the full
payments repository is `thesouledstore-tss/backend-tss-domestic_payments_api` at
`434f3e438d1cb48c64e5723222c6efda506db571`. The observed
`frontend-tss-website` repository is empty. The separately inspected legacy
`laravel-web` is pinned to `463a826217709457f96eb9920254e8c970fddd8a`; it is not
evidence of a current React API-v2 caller or a screening-marker writer.

The foundation implements separate source-origin commands and proofs instead
of manufacturing a Node operator, customer login, CSV operation or actor zero.
Native owned RC creation retains the real original customer/staff authority,
nonce, cart namespace, request/reference hashes, current screening projection,
source Order/HP/marker hashes, encrypted original effects and creation receipt.
Original source commits flush inside the outer transaction. Unknown outcomes
are read from the original command; a typed rolled-back admission denial can
seal a no-effects closure. A timeout/404 never becomes that proof.

Legacy grants come from the actual Django session or a new opaque MPos session
issued only after the literal successful password/TOTP branch and real User
object. Native actor/Store/counter/assignment, session, grant and customer checks
are independent of browser fields. Logout/check-in transitions revoke these
grants. The original customer JWT remains independently required. No raw JWT,
API key, browser form/cart/contact, or session key is copied into the command
metadata. Original effect/legacy response payloads are encrypted at rest.

`legacy_execution.cash_completion` wraps the original cash helper in a native
transaction with its immutable receipt and counter writer entry. Its two HTTP
producers are retained for postcommit dispatch; there is no HTTP while the new
cash transaction holds authority locks. Existing plain unselected calls retain
their original functions. The source request fence never reruns a lost original
view or substitutes an HTTP paid flag for the genuine Go receipt.

Root integration hooks for this foundation:

- Register `compatibility/upstream/screening-origins/migration.sql` as a NEW
  additive control migration, preserving existing checksums. The history head
  SQL is a separate review/publisher deployment and must not be auto-applied.
- Add `legacy-order-imports/screening_origin_pending.py` and all new origin
  modules to the source bundle. Existing Node/CSV/public admission now adds
  other-origin credits under the same global customer lock. Missing tables or
  a missing proof key with a retained origin row fail closed.
- Compose `source_hooks.api_changes(changes)` AFTER the public source changes.
  It calls `OriginBootstrap.activate` after public activation and registers the
  source authenticated command POST/GET resources. It is disabled with no
  database/network work when `POS_SCREENING_ORIGIN_CONTRACT` is absent.
- For original legacy Django, compose `source_hooks.legacy_changes(root)`
  against pinned POS source `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. These are
  reviewable bytes, not edits to that checkout. Its nonce caller is installed
  only for the selected screening flow; existing plain calls remain unchanged.
- Node history bridge export is `registerOriginHistoryBridge`; its producer is
  `originCustomerHistory(config, options, sourceProofKey, dependencies?)`, with
  a bounded SELECT port, optional encrypted demand queue and clock. The runnable
  service is `npm run receiver:origin-history` and the container target is
  `origin-history-receiver`. It mounts the authenticated route independently of
  the public app. See [deployment configuration](../compatibility/upstream/screening-origins/history-bridge-deployment.md).
  It uses only explicit BQ publications/counts, complete cohort conservation and
  the immutable native mutation witness. No historical MySQL request fallback.

Selectors/configuration (all disabled unless explicit):

- `POS_SCREENING_ORIGIN_CONTRACT=pos-screening-origins-v1`;
  `POS_SCREENING_ORIGIN_PROOF_KEY` is an independent 32+ ASCII-byte secret.
- `POS_SCREENING_ORIGIN_DJANGO_ALIAS` defaults to the actual source router's
  `mysql_db`. Authenticated principal/native password identity must match; an
  unproved cross-database actor namespace is refused.
- `POS_SCREENING_ORIGIN_HISTORY_BRIDGE_URL` is an exact HTTPS private bridge.
  `POS_SCREENING_ORIGIN_HISTORY_CONTRACT=pos-screening-origin-history-v1`,
  `BQ_SCREENING_ORIGIN_HISTORY_PUBLICATIONS_VIEW`,
  `BQ_SCREENING_ORIGIN_HISTORY_COUNTS_VIEW`, and independent
  `POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY` select the Node reader.
- `POS_SCREENING_ORIGIN_HISTORY_DEFINER` qualifies the actual native head/log
  trigger definer; publisher capture uses separate explicit read-only source
  credentials and `POS_SCREENING_ORIGIN_HISTORY_CAPTURE_KEY`.

Remaining code at this foundation checkpoint: complete source CSK wrapper and
its authenticated durable payment/async jobs; actual legacy/browser nonce mount
and manager recovery/publication worker; source member/gift/coupon-specific
composition and negative/unknown final edges; finish independent executable
history publisher/candidate and privileges qualification. Admin independently
owns the genuine non-POS Go confirmation/failure/effect adapters. CPP owns the
history handoff/publisher continuation. These are CODE work, not external-only
acceptance. Final source/native/browser/Go tests and parity follow feature code.

The bounded runtime and encrypted queue are integrated on `86ca3d0`; the actual
private process, configuration, migration registration and packaging are on
`47dcd22`. Unchanged customer-head generations no longer expire solely because
their publication is older than a minute; operation responses retain their
60-second maximum lifetime. The independent source capture and publisher are
still implementation work. These commits have not undergone the deferred final
validation phase.

The caller/system checkpoint is now integrated as `202b03c`: the pinned legacy
URL/template/static nonce mounts, true session/grant recovery and actual legacy
effects command are present. The Node publisher implementation is integrated as
`197ac08`, and the non-POS Go foundation/composer as `94a2729`. Root has generated
their composed payments source and retained its pending-validation manifest;
this is source artifact generation, not an application build or parity result.
Source member/gift/coupon variants, source effect-worker installation, CSK
preparation continuation, MPos customer-JWT client, exact Go asset verification
and remaining provider/privacy/recovery edges are still implementation work.
Publisher budget checkpoint ordering and the global privilege audit are also
still assigned code follow-ups. All previous final acceptance requirements remain.
