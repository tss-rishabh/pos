# Reviewed global voucher corrections

The user approved exact paise issuance. These are review artifacts; no source sibling, production schema or provider was changed.

`manifest.json` pins the before/after/patch SHA256 for three tiny source changes:

- The global POS issuer copies the exact coupon `initial_val` into ordinary voucher value, preserving the generic coupon INT and purchased gift-card behavior.
- The API standalone check maps an ordinary voucher's NULL end date to its legacy zero-date display sentinel, preserving “Won't Expire.” The current source cart already excludes ordinary vouchers from date enforcement and removes dates from its response.
- The API history enum gains the source-intended `GV_ADD` name; no compensation alias is substituted.

`legacy-compatibility.review.sql` is intentionally excluded from automatic rewrite migrations. It allows the explicit non-expiring NULL validity representation and adds `GV_ADD` to the verified physical ENUM without changing existing values/collation. It must be reviewed and deployed with compatible readers before enabling the Node issuer. Runtime preflight also checks the actual writer's nullable fields and enum.

The tiny source issuer patch establishes the exact-value business difference. It does **not** fix its other omitted required fields, interpolation, partial autocommits or logging, and is not a complete deployable legacy handler. The actual Node writer supplies each required field, uses bound ORM statements, preserves a durable UUID receipt and commits all financial rows atomically. No generic coupon column widening is needed.

`tools/global-vouchers/compatibility-oracle.py` verifies every hash, dry-applies patches in temporary files, and executes the pinned current cart/check consumers plus the actual source PIN limiter with an expiring in-memory Redis recorder. `source-oracle.py` separately executes the last historical conversion before its removal, demonstrating the prior no-PIN repeat-credit and staged-ledger behavior. Both avoid application imports, credentials, network and live SQL. Native tests use only an isolated local database and explicitly apply the review-only SQL there.

Production acceptance still requires writer/consumer rollout, shared external cart/wallet/voucher mutation coherence, source feature-flag alignment and verifiable funding for legacy gift cards. A paid status and HP voucher pointer do not independently certify old asynchronous funding. See `parity/global-vouchers.md` for the exact boundary and tested behavior.
