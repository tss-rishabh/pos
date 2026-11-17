The origin payments overlay is implementation work with final validation pending.
Its selectors remain empty by default. No provider, schema, build or deployment
acceptance is implied by the saved source.

Root's assembler invokes `compose.py::compose_payments(target, reference,
generate=None)` last, after ordinary/exchange/CSV/public/current-counter
composition. `reference` must contain the exact clean payments commit
`434f3e438d1cb48c64e5723222c6efda506db571`; only the independent target is
written. `generate(args)` returns the standard-library Go AST producer's
stdout. Neither producer nor composer starts the payments application.

The resource is POST/GET
`/api/v2/payment/screening-origins/:commandId/payment`. POST retains the
original `POrder` names (`order`, `method`, `payment_method`, `platform`, `os`)
or the original CSK `{order,method,isValid,name}` result. Customer/staff calls
retain the genuine original JWT; staff also needs the current source grant and
session. CSK uses its purpose-HMAC payment submission/read authorization plus
the actual configured/native current CSK service authority. It never receives
customer/operator authority by merely choosing `method=3`.

Positive CSK prepaid is an original feature: API2960
`controllers/external/OrderPlacement.py` forces the strict CSK pricelist and
prepaid under `validate_api_key`; `libs/OrderHelper.py` deliberately exempts
`external_api` from its positive-total prepaid refusal. The new
`funding-declaration` proof preserves that authority and calls it
`external-system-csk-prepaid`. It is not a bank receipt. Customer/staff ordinary
prepaid retains the original zero-payable rule. Original COD/COC confirmation
can remain native payment status1; `CONFIRMED` is never a synonym for cash
collected or gateway paid4.

`origin_assets.go` consumes the source's own `assets` descriptor before
provider dispatch and again before allocation. It verifies full native HP gift
links, voucher identity/value/recipient/date hashes, current ordinary member
state/revision and actual ordinary provenance when present. A missing ordinary
provenance row stays missing. The Go activation has its own source-origin
receipt; it does not manufacture a Node/CSV or ordinary staged-v2 grant.
Digital `GIFT_VOUCHER` rows may legitimately have no HP; their original
order/customer/full voucher hash is still mandatory. A physical `GIFT_CARD`
always retains its real HP relationship.

The optional source `couponHash` is consumed before provider dispatch and
again around the literal Go confirmation/decline. Source-prepaid consumption
keeps its original source log and is never debited twice. Go-side consumption
follows the actual ordinary/store branch; exchange/HL branches retain their
literal zero counter delta rather than manufacturing a coupon log. Native
per-HP discounts/refundable amounts remain unchanged. Current-controls-only
manual coupons carry `historyRequirement=current-controls, history=null`;
historical branches require the authenticated BigQuery history identifiers.
No historical scan or empty-history substitution is added in Go. Optional
welcome consent is source-native sealed evidence, not a new Go consent policy.

Manual review migration order is the source origin foundation, source
`screening-origins/assets-migration.sql`, then this directory's
`migration.review.sql`, with the existing qualified current counter,
membership fence/version and gift-card issuance schemas installed. Runtime
code performs no DDL and uses no historical raw Order/HP count fallback.
Additional review-only migrations are `screening-origins/origin-coupon-migration.sql`,
then this directory's `coupon-migration.review.sql`,
`admission-migration.review.sql`, `provider-migration.review.sql` and
`exchange-migration.review.sql`. The original migration checksum is unchanged.

New configuration names are:

- `POS_SCREENING_ORIGIN_GO_CONTRACT=pos-screening-origin-payments-v1` for new
  admission; empty leaves it unselected.
- Retained `POS_SCREENING_ORIGIN_PROOF_KEY`, independent from the retained
  `POS_LEGACY_IMPORT_PROOF_KEY`, membership proof key and original JWT/provider
  secrets; `POS_SCREENING_ORIGIN_CSK_API_KEY` is the real original CSK credential
  and is never forwarded in a URL or logged.
- `POS_SCREENING_ORIGIN_OVERSELL_MODE=legacy|shadow|reserve`, checked against
  the genuine source Redis mode before SQL; missing/unreadable mode is refused.
- Explicit TLS Redis aliases
  `POS_SCREENING_ORIGIN_{INVENTORY,HOLD,WALLET}_REDIS_URL` bind the original
  aliases. They must point to the same source inventories/locks, not new empty
  caches.
- `POS_SCREENING_ORIGIN_GO_EFFECTS_CONTRACT=pos-screening-origin-go-effects-v1`
  and `POS_SCREENING_ORIGIN_DATABASE_DSN` select the separate
  `cmd/screening-origin-effects` worker. Empty/DEMO exits before connection.
  Original HTTP effect endpoint/credential names are retained.
- `POS_SCREENING_ORIGIN_GO_COUPON_CONTRACT=pos-screening-origin-coupon-consumption-v1`
  selects the exact source coupon descriptor consumer; empty refuses new coupon
  admission. The original `IS_DEDUCT` value is frozen into the original attempt
  and must still agree before financial allocation.
- The existing current-counter and membership revision/product/key options
  retain their independent original contracts and actual writer definitions.

Dispatch commits SENDING before provider I/O. Replay never calls Start again;
GET consults the original provider reference. The pinned Gokwik status API is
POST `payment/verify` (a provider read), while the new public recovery resource
is GET and never calls `order/create`. A missing Gokwik creation ACK without
its provider identifiers remains unknown until an authenticated original
callback and the real `payment/verify` response establish their immutable
order/request link. Recovery then uses that link, never `order/create`.
Where the original CREATED ACK row never existed, the retained dispatch-start
timestamp is a conservative, non-extending two-hour bound; it is never presented
as a fabricated CREATED ACK. No provider lookup endpoint is invented.
Genuine callbacks/cron use their real original signature/header or
authenticated provider read; missing/disabled callback secrets do not qualify
a selected origin. The old unprotected Gokwik cron now requires its actual
configured CRON header when origin handling is installed.

The initial authenticated GET returns bounded404 when there is no attempt.
That response is not absence proof. Definite refusal BEFORE durable SENDING
can instead atomically retain a `payment-no-effect` receipt and fence this
original command against any late POST. Accepted attempts win that race. This
receipt proves only no dispatch by this Go sender: original source orders,
benefits, cache locks or wallet staging are not declared undone.

Immutable completed reads use genuinely current read authority while retaining
the old command/creation/payment proof. Customer contact, genuine staff login
or CSK service-key rotation cannot rewrite that original receipt. New financial
dispatch still requires its original stage authority. A current service read
does not silently become authority to resume an old DIRECT financial stage;
the separately coordinated source stage-recovery descriptor/use is remaining
implementation work at this checkpoint.

The real CSK externally-prepaid declaration remains distinct from bank payment.
Original express-parent/reshipping/original-prepaid exchange selectors have
their own native source-exchange declaration; their full source online/store
allocation body is retained. Genuine charged observations that pass signature,
amount, window and native fences enter the source's captured8→paid4 branch;
this closes the TXN_CREATED race and the original method15 omission. COD/COC,
late, declined and underpaid outcomes cannot use that branch. Underpayment
keeps the original AMOUNT_MISMATCH ledger/comment and optional alert in the
durable outbox while retaining the order unconfirmed for manager handling.

Original HTTP2xx acceptance is recorded as transport acknowledgment, including
line-cancel delivery; it is not a fabricated refund completion. SENDING/UNCERTAIN
effects are retained and never automatically resent. The legacy real-cash asset
finalization is a separate source-owned receipt, preserving the immutable Go
unpaid COC proof rather than rewriting it.

Existing tests are preserved. These are implementation checkpoints pending the
later source/native/provider/browser acceptance phase; no new tests, builds or
verification runs were performed under the user's implementation-first order.
