# Legacy cash asset funding

Implementation checkpoint pending the deferred validation phase. All selectors
remain off and no live writer/provider work was run.

Register additive `screening-origins/legacy-assets-migration.sql`, package
`legacy_assets.py`, and select
`POS_SCREENING_ORIGIN_LEGACY_ASSETS_CONTRACT=pos-screening-origin-legacy-cash-assets-v1`
only with the existing origin asset and real gift issuance contracts qualified.
Plain no-asset cash retains the existing path without this selector.

The original Django cash helper is invoked once under current original
actor/epoch/session/check-in/Store/counter/customer/order authority. It requires
the genuine prior source creation and Go confirmation. Native header/line
economics and exact Go status are checked before payment; a completed or
cancelled unrelated transition cannot be overwritten as a new cash sale.

Go COC placement truthfully retains `funded:false`. After the actual original
cash helper sets paid4 and activates the real vouchers, the same native
transaction writes physical gift issuance rows with the existing native gift
identity hash. Collection locks precede voucher locks, and the exact original
HP relation/quantity/value/code/dates must remain intact. Already funded
zero-payable Go orders verify existing issuance instead of inserting again.

A separate immutable `legacy-cash-assets` proof binds the original cash input,
native final header/counter, creation/asset/Go activation/payment hashes and
actual issuance rows. It never rewrites the original Go receipt or invents a
second Go/bank payment. Digital source gifts retain their own source-native
descriptor rather than fabricated physical collection rows.

The pinned Django helper does not write membership EAV. Existing Go activation
remains the membership fact; cash records and preserves the actual unchanged
current member state/revision. It does not reapply membership, replace unrelated
newer entitlements or manufacture an absent staged-v2 provenance record.

Source creation and asset descriptor now share one timestamp, matching the
strict independent Go consumer. Legacy current-scope recovery also uses
Store-before-request-row ordering; its read-only metadata path does not take a
request-row lock before acquiring Store authority.
