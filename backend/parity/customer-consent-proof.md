# Immutable customer consent proof

Every ordinary checkout projection now also requires a transaction-bound
`pos_rewrite_checkout_customer_consents` row. Migration0017 creates only this
rewrite table; it neither changes source tables nor backfills historical consent.
The source Go confirmation adapter owns ordinary proof publication, while the
cash-only offline importer records its explicit no-consent decision in the same
local transaction as stock, source order and projection evidence.

The Node consumer checks the exact order/customer/store/counter, final native
header hash and `pos-customer-contact-consent-v1` contract. Positive native Money,
Points or voucher amounts independently require `required=1`. The source writer
also freezes whether the original coupon required employee verification; current
coupon edits must not rewrite that original decision.

For required consent, original operator, contact revision and digest must be
present. The accepted instant must precede the fixed verification expiry by at
most fifteen minutes. All IDs/revisions use native BIGINT decoding without Number
coercion. For cash-only `required=0`, contact revision/digest/expiry must be NULL.
This marker proves that the new guard ran; an older ordinary projection alone
cannot stand in for it. Existing payment/stock proof checks remain required.

Crucially, the committed proof is never compared with the customer's current
contacts, current revision or the current clock. An expired or subsequently
changed contact cannot erase money already committed. New confirmation checks
belong under the source customer lock before mutations and before commit; they
are distinct from this immutable receipt reader.

The shared projection checker and staff feedback service follow the source
Order-then-customer lock order. Offline cash writes an explicit no-consent row
with the native final header hash, original operator and import instant. Its
existing source-template guards and the shared checker reject positive wallet,
Points or voucher amounts, preserving completed cash sales without requiring OTP.

Twelve focused native MySQL cases pass: missing/cash markers; each positive asset;
originally valid but now expired proof; full-width revision; every immutable scope
and hash binding; old contract; malformed proof; invalid native financial values
and identifiers. The fixture deliberately has no current customer, coupon or
contact-revision table, proving the reader does not consult mutable contact state.
Malformed-publisher cases temporarily disable only the constraints on the
randomized localhost fixture table, then erase the malformed row and re-enable
them using [MySQL's per-constraint syntax](https://dev.mysql.com/doc/refman/8.0/en/alter-table.html).
No live schema/data was modified.

The checkout and offline-import native fixtures now install0017 and seed their
consumer attestations. Full source Go concurrency, safe OTP integration, provider
acceptance and the coherent project verification remain separate checks; focused
Node tests do not certify their deployment. Original unsafe legacy OTP transport
stays disabled. See `customer-otp.md` and the pinned Go compatibility evidence.
