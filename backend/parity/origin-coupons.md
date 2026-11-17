# Genuine other-origin coupons

Code-first implementation; no new tests, parity runs, typechecks, builds or live
provider/native/warehouse writes. This is separate from CSV financial authority
and from Node operator public-screening admission.

The pinned API-v2 2960 source supports retained/manual codes and automatic
birthday selection. `MetaInitializers.get_valid_coupon` performs native deletion,
validity, type, exclusive-birthday, employee-domain, platform, first-user,
user-specific lifetime/monthly and lot checks. `CouponValidation.apply_coupon`
retains fixed/percentage/m*n arithmetic, product/category/country predicates and
the welcome-registration condition. No source coupon price/tender is invented.

Five historical facts match the existing generic generation publisher literally:
global coupon usage; today's customer+coupon usage; first-user all-order count;
monthly customer+coupon log-to-order multiplication; per-lot coupon groups with
native code/PAD SPACE comparison. Existing future records remain included where
the source has no upper bound. The new runtime uses `generationReadRunner` and
independently verifies the native capture, reduced warehouse projection and
publication seal, then binds those facts to the genuine origin command with its
own HMAC purpose. It never constructs a CSV operation/plan or Node checkout.

Welcome registration is current consent, not old-order reporting: the original
`welcome_offer.email_id=users.email` join is read under the genuine current user
lock with a verified email-prefix index, native equality and no date/user_id/
coupon filters. Matching native row hashes and the native current email identity
are retained without exposing email. `docs/tss-production.sql:13176` declares the
PK and full `email_id` index; actual current index/collation qualification remains
mandatory. No live DDL is issued. A missing index needs a separately reviewed
`CREATE INDEX ... ON welcome_offer(email_id)`, not a full-table fallback.

The original customer `Order` calls `prepaid_amount_deduction` only when actual
`PREPAID_AMT_DEDUCTION` is enabled. That includes one native coupon-user increment
and one `order_coupon_log`. `PosOrder` does not call it. The sealed descriptor
therefore distinguishes `source-prepaid` from `go-confirmation` and retains exact
before/after user counters, original source log, header and every native HP/refund
hash. Go must run its original matching branch only and append consumption or
reversal evidence; it must never deduct a source-consumed coupon twice.

The source factory is `origin_coupon_runtime.configured_coupons`. It returns
SourceCoupons, the bounded private history client, an installer and optional
private control-resource mount, without doing I/O. Source/CSK owners must call:

1. `snapshot(customerId)` outside SQL (private actual Redis configuration and
   legacy birthday EXISTS observation, signed, <60 seconds; never persisted raw).
2. `prepare(session,command,kind,namespace,snapshot,cart_meta=...)` before the
   first cart/meta hydration. CSK supplies its genuine saved `{items:[...]}` meta.
3. `request(command,selection)` and `history_provider.read(request)` outside SQL
   for each of at most two candidates (manual and eligible automatic).
4. Reauthorize native principal/customer/cart/command, then `save(...)` in a fresh
   owned transaction. Immutable preparation versions retain their original facts.
5. Enter `before(frame,snapshot)` before CartFactory/meta initialization; the
   installer routes only selected source function calls through literal compiled
   source and exact BQ replay. Unselected calls retain their original functions.
6. `capture(frame,headerHash,now)` before creation seal, using that exact shared
   `now`. Omit creation.couponHash entirely when no coupon remains. An applied
   coupon always needs its actual retained descriptor. Immutable reads use
   `origin_coupon_contracts.read` and do not need current history/configuration.

A cooperative birthday claim uses the existing native customer guard and an
origin-domain opaque mutex owner, not a fabricated CSV operation. The claim and
Order share the original transaction. No Redis write is performed under SQL.
Retained legacy Redis keys and all-writer participation remain a required cutover
condition; absence of one key is not proof that unpatched writers cooperate.

`origin_coupon_heads` consumes Root's authenticated
`qualified_head_metadata(session)` and matches ten real coupon trigger hashes.
Its native owner variable is the original genuine command UUID. Late head locks
and a physical commit guard reject intervening foreign mutations. The source's
additional originHistoryPolicy enters the authenticated configurationHash, so an
old weaker-policy generation cannot be rebound. No caller/publisher TRIGGER grant
is required. Root owns that common metadata and native publisher adapter dependency.

The private source control endpoint is GET
`/internal/screening-origins/coupons/controls/:couponId`; header
`X-POS-Origin-Coupon-Controls-Key` is independent. It returns the shared generic
control envelope from real current cache/settings/coupon/policy, with no customer,
operation or historical count. This covers manual IDs as well as birthday IDs.
Node's `originCouponRuntime` plus `registerOriginCouponHistoryBridge` supplies POST
`/internal/screening-origins/coupon-history` with genuine command and request HMAC.
The private reader injects the bounded SDK port and explicit readonly credentials.

Source selectors: POS_SCREENING_ORIGIN_COUPON_CONTRACT=pos-screening-origin-coupon-v1,
POS_SCREENING_ORIGIN_COUPON_HISTORY_URL (HTTPS exact private bridge path), optional
POS_SCREENING_ORIGIN_COUPON_HISTORY_CA_FILE; optional controls selector
POS_SCREENING_ORIGIN_COUPON_CONTROLS_CONTRACT=pos-screening-origin-coupon-controls-v1
and independent POS_SCREENING_ORIGIN_COUPON_CONTROLS_KEY. Node reader selector:
POS_SCREENING_ORIGIN_COUPON_HISTORY_CONTRACT=pos-screening-origin-coupon-history-v1.
Shared generic generation view/comparison/budget options remain the existing
explicit CSV_COUPON generation settings; their facts confer no CSV authority.

Intermediate checkpoint CODE still pending: manual-ID durable demand/worker
composition, shared source/CSK/bridge/bootstrap integration by their owners,
common authenticated metadata adapter (Root), and Go consumer/consumption and
reversal receipt (Admin). No runtime refusal is called full feature completion.
`origin-coupon-migration.sql` is additive rewrite-only; Root registers/packages it.
Legacy trigger/definer/grant cutover is manual and qualification remains deferred.
