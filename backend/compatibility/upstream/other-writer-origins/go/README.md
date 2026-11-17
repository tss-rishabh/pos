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

Manual review migration order is the source origin foundation, source
`screening-origins/assets-migration.sql`, then this directory's
`migration.review.sql`, with the existing qualified current counter,
membership fence/version and gift-card issuance schemas installed. Runtime
code performs no DDL and uses no historical raw Order/HP count fallback.

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
- The existing current-counter and membership revision/product/key options
  retain their independent original contracts and actual writer definitions.

Dispatch commits SENDING before provider I/O. Replay never calls Start again;
GET consults the original provider reference. The pinned Gokwik status API is
POST `payment/verify` (a provider read), while the new public recovery resource
is GET and never calls `order/create`. A missing Gokwik creation ACK without
its provider identifiers remains unknown. No provider lookup endpoint is
invented. Genuine callbacks/cron use their real original signature/header or
authenticated provider read; missing/disabled callback secrets do not qualify
a selected origin. The old unprotected Gokwik cron now requires its actual
configured CRON header when origin handling is installed.

Remaining code at this checkpoint includes provider/native-log/retained-token
normalization, definitive technical admission receipts, full effect/recovery
edge cleanup and the exact asset/cash-finalization integration with the legacy
caller. Those are implementation items, not deployment certificates. Existing
tests are preserved; no new test/build/verification runs were performed under
the user's implementation-first work order.
