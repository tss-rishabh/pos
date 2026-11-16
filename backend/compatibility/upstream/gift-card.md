# POS physical gift-card compatibility

Prepared against API-v2 commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. No sibling source was changed and no patch was deployed. `gift-card-manifest.json` records the pinned source and SHA-256 of `patches/api-v2-pos-gift-card.patch`. Normal `python3 compatibility/upstream/prepare_gift_patch.py` verification is read-only; `--write` explicitly regenerates artifacts from exact committed inputs.

The original POS accepts an integer custom face value from 1 through 10000 and sends `custom_data.gvprice`. Its pinned API-v2 initializer replaces that amount with the catalog denomination. API-v2 also uses second-resolution gift item IDs and rejects repeated cards of one product. The source order/calculation builders already recognize `custom_price` and use gift face value as payable.

## v2 behavior

- POS items carry exact positive decimal `custom_data.pos_gift_id` within signed BIGINT. The identity survives rehydration. Changed identity, invalid IDs or quantity other than one are rejected. Online/default indexing is preserved.
- POS `gvprice` must be an actual integer in the source range. Price and face amount match; catalog special prices are cleared and the initializer establishes `custom_price`. A client flag never establishes custom pricing. Default denomination, metadata and tax fields retain their original values.
- Different physical-card IDs may use the same SKU in POS; duplicate physical IDs are rejected. The original online one-gift-per-product restriction remains.
- Actual `PosOrder` creation locks writer `gift_card_collection` before inserting its disabled voucher and retains that lock through voucher+source HP commit. Missing, blocked, unprinted, incomplete or anomalous collection flags are rejected. Source serial structure/collection and positive generated index within collection size are checked.
- Creation flushes for the voucher ID, builds its source lines and commits once. A missing/failed line rolls back the voucher. The source absent recipient phone `''` uses its real ORM/default numeric absence `0`, matching physical `BIGINT NOT NULL` under unchanged strict mode. Code, value, dates and disabled state are preserved.

The old length-only serial-index check accepted zero/out-of-range indices; rejecting those is an explicit input-integrity correction. Existing unique voucher codes are never overwritten/reissued, including after cancellation: the old preflight suggested reuse although its retained physical UNIQUE code cannot be inserted again. No historical value is deleted to make reissuance succeed.

## Funding fence

A disabled voucher is not funding proof. The composed Go ordinary confirmation and Node counter settlement share the batch block/print writer lock. Collection rows lock in sorted order before voucher rows; readiness is rechecked before mutations. Cash-on-counter confirmation leaves cards disabled. Prepaid activation commits with source wallet/stock/payment; counter activation commits with confirmed cash/provider settlement. Failed activation/proof rolls the transaction back.

Migration `src/modules/checkout/migrations/0015_gift_card_issuance.sql` records immutable `pos-gift-card-issuance-v1` evidence per voucher. Explicit order/voucher/collection/serial fields and identical native MySQL JSON_OBJECT/SHA256 expressions bind customer, code, original face value and dates. Node and Go never serialize these values to establish the hash. There is no automatic historical backfill.

Pending orders recheck readiness at confirmation, before charge and during settlement. A batch block during an external charge can leave money received but funding unconfirmed: the original attempt remains uncertain, preserves its reference and never charges automatically again. After authorized batch repair, an explicit provider inquiry can complete that exact settlement. A later block or legitimate redemption does not erase the paid receipt: completed reads verify immutable evidence and ignore current collection flags, spendable value and status. Missing/tampered evidence stops completion/replay.

## Evidence

`python3 -m unittest discover -s compatibility/upstream/tests -v` runs 21 checks, including 12 gift checks. They apply patches to disposable copies, compose exchange+approved per-HP refund changes, and execute original initializer/validator/indexer/total/voucher-constructor declarations plus candidate issuance locking/rollback guards. No application startup is imported.

`tests/checkout/gift-issuance.mysql.integration.test.ts` executes the actual pinned SQLAlchemy voucher class+constructor and candidate SQL/session against verified isolated native columns. Seven assertion phases reproduce strict empty-phone failure, prove numeric-absence compatibility, preserve source values, reject duplicates, roll back failed lines, wait for a competing batch block, and retain SQL mode. No card is funded.

`tests/checkout/mysql.integration.test.ts` adds four native cases: flags before charge, block during charge→uncertain→one exact reconciliation, twenty callbacks→one activation/proof, and late rollback. Missing/tampered evidence and later block/redemption are covered. Eight gift-domain checks cover exact native Go/Node hash identity, generated serial range and rejection of old saved quotes. Strict fixture config: `tools/checkout/gift-issuance.tsconfig.json`.

The race-enabled Go suite adds five native gift groups covering flags, twenty prepaid replays, unpaid disabled state, proof-failure rollback and shared collection locking. It runs 28 top-level groups including the original ordinary privacy/allocation cases. The actual archived payments application, package and worker compile without starting.

## Activation

Review/apply this API-v2 patch and composed payments patch to actual deployed revisions, apply 0015, then certify default/custom addition, reload, quote, creation, block/print contention, funding and lost-response recovery in an approved sandbox. Audit every other voucher creation/activation writer for this same fence. Verify private fresh-customer context and customer/POS authentication; restrict direct service access. Unpatched external writers, provider certification and authoritative deployment evidence remain gates.

Set `UPSTREAM_POS_GIFT_CARD_CONTRACT=pos-gift-card-v2` only after certification. The old v1 value is rejected, including saved gift quotes before order dispatch. The rewrite independently confirms item identity, price and face value; a known mismatch removes only the known new item, while unknown outcomes freeze. A response/configuration flag never proves deployment or funding.

`DEFAULT_GC_EX_DAYS` retains the source 90-day default in `BUSINESS_TIMEZONE`; each card has its own selected validity and number. Raw card data is excluded from logs and identifier-only browser recovery storage. This bounded evidence does not certify every legacy provider/refund/webhook path or full route parity.
