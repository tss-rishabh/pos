# Source-origin asset provenance

Implementation checkpoint, pending the final validation phase. The selector is
off by default. No source/provider/database deployment is implied.

`POS_SCREENING_ORIGIN_ASSET_CONTRACT=pos-screening-origin-assets-v1` installs
`OriginAssets` in the genuine customer, legacy staff, MPos and CSK source frame.
The current global customer, ordinary membership revision/fence, and sorted
physical gift collections are locked before the original Order is created.
The original source constructors, pricing and member mutations still execute.
The descriptor records their native result; it cannot declare payment or fund
a gift voucher.

Register `compatibility/upstream/screening-origins/assets-migration.sql` as an
additive migration and package `origin_assets.py`. The selected producer also
requires the existing ordinary membership native revision contract, independent
membership proof key, and product IDs verified against original settings. No
public Node or CSV capability is accepted as a source-origin authority.

Creation adds `assetsHash` only when a real asset is present. Its source-key
`assets` HMAC covers the native order header, every HP gift link, full native
gift identity/value hash, original customer, and before/after member states and
revision. A genuine ordinary staged provenance row is retained when it exists;
absence remains null rather than manufacturing that record. An unchanged
member state can be recorded for an original explicit member SKU.

Without this producer, the existing asset guard refuses newly created gifts or
member writes before commit. The independent Go origin adapter must verify the
descriptor and exact native ownership before provider creation and before the
original allocation. This producer checkpoint alone does not close that consumer
or the remaining source history/effect variants.

The source HP model exposes `gv_id` for physical `gift_voucher_id`. The frame
now reads the verified physical column with an explicit alias. Original empty
recipient phone becomes the native absence value zero; missing voucher dates
become actual SQL NULL only after nullable native date columns are verified.
No legacy DDL or invented dates are applied by the source frame.
