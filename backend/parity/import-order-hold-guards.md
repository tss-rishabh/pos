# Imported-order holds in ordinary mutation paths

This slice applies the existing `assertImportOrderMutationAvailable` contract to
ordinary payment, pending cancellation, return/refund, exchange and order
finalization. It does not change tax, benefits, membership provenance, refund
allocation, stock arithmetic or payment eligibility. Original POS reference is
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`; this is a safety boundary around the
rewrite's durable CSV import, not a claim that the legacy application had that
boundary.

The imported source order becomes visible together with its hold in the private
receiver transaction. A source response is not permission for another writer to
act. A held/incomplete binding blocks; a completed binding needs its sealed
immutable completion and the matching native order/customer/store/counter/HP
identity. The retained `LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1` is the existing
master secret. No public operation UUID bypasses the check. A missing control
table is an error, never evidence of an unbound order.

The central locked scope functions now check the hold before payment start,
options, list/detail/replay, terminal adoption, provider status/cancel claims,
pending cancellation, return/exchange creation, inbound acceptance, refund
dispatch, stock restoration and completion. Finalization and prepaid settlement
reads independently check it. Exchanges check the known parent and replacement;
an injected finalizer is preceded by the repository check, and the default native
finalizer repeats it in its mutation transaction. Replacement discovery checks
the selected child's hold before adopting that checkpoint.

Provider responses already received are evidence, not a new financial authority.
Private payment state retains the first exact typed `heldProviderDecision` and
returns an uncertain attempt without payment/ledger/stock/outbox completion.
That field is omitted from public payment DTOs. The original attempt and provider
reference remain bound; a stale busy-operation response cannot replace them.
Refund-confirmed amounts, replacement-confirmed child IDs and definite inbound
rejections retain their existing metadata paths. A confirmed inbound response
whose native acceptance fails is uncertain, with a distinct confirmed-response
code; it cannot become a fabricated definite warehouse rejection or an automatic
PACK repair obligation. No evidence-only path dispatches another provider call.

Store locks precede Order locks. Known parent/replacement Order IDs are locked in
ascending native BIGINT order; the finalizer reads an unlocked parent hint and
rechecks the locked parent before any write. A changed return operation's locked
order/line/counter/child scope requires a fresh read. The native concurrency case
holds the parent from one store while another store finalizes its replacement,
observes the actual MySQL lock wait, then obtains the child without a lock cycle.
The existing INT-only source exchange-ledger eligibility gate remains intact;
wide-ID evidence tests do not certify creation of unsupported legacy exchanges.

No new migration or public route is introduced. Deploy the already supplied
`legacy-order-imports/financial-proof-migration.sql` before these cooperating
writers. Root composes the same imported-order check with the pending physical
cash-return check in the whole-order typed handover barrier under its existing
Store→Order locks. This slice does not select an unaccepted provider receiver.

Focused native evidence is in `tests/import-order-holds/mutations.mysql.test.ts`:
active and missing/wrong-key holds, completed/tampered proof, no UUID bypass,
absent-table failure, all provider terminal/unknown outcomes, actual mocked
terminal dispatch followed by a hold, no repeat charge, inbound/refund/replacement
evidence, parent/child holds, prepaid reads, unchanged unbound cash settlement and
the cross-store lock-wait case. It uses randomized isolated schemas through the
existing verified physical-metadata fixture; all external effects are mocks.

Run with Node 24 and
`CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test`:

```sh
node node_modules/vitest/vitest.mjs run --config tools/import-order-holds/vitest.config.ts
node node_modules/typescript/bin/tsc --noEmit -p tools/import-order-holds/backend.tsconfig.json
```

Existing checkout/offline-cash import and rejected-return repair native groups
are also regression checks. Fixture prerequisites add the financial control SQL
without replacing root's whole-status/repair prerequisite groups. No live
provider, production database, message, stock procedure or warehouse write is
used. Production transport acceptance and the complete application's release
certification remain separate gates.

At this isolated checkpoint, the focused group passes all 22 native cases,
the original offline-cash-import group passes 6 source/native cases, and the
rejected-return repair group passes 18 native/HTTP cases. Strict compilation and
owned-file lint pass. The older checkout fixture produced 64 passing cases after
supplying its missing auth-epoch prerequisite; two unrelated public-browsing
denial assertions differ on this older dependency branch. Those assertions are
preserved. Root owns rerunning them with its later order-history integration;
this document does not report that older 66-case group as fully passing.
