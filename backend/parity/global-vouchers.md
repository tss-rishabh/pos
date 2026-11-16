# Global gift vouchers: source contract and correction proposal

Status: implementation in progress; production activation remains disabled. No source sibling, production database or external provider has been changed.

## Approved exact-value correction

The global form accepts a positive amount and generates an ordinary `GIFT_VOUCHER`. Its number input has no explicit step, but its click handler directly sends AJAX; browser form validation does not prevent a fractional request. The source inserts that input into `coupons.voucher_val` (physical INT) and `coupons.initial_val` (DOUBLE), then copies the INT into `gift_vouchers.voucher_value` and the DOUBLE into `voucher_initial_value`. Its `GV_ADD` history records the original input.

An isolated strict MySQL execution of those physical types produced:

| Input | Coupon / stored redeemable value | Initial value / issuance history |
| --- | --- | --- |
| ₹100 | ₹100 | ₹100 |
| ₹25.50 | ₹26 | ₹25.50 |
| ₹25.49 | ₹25 | ₹25.49 |
| ₹0.01 | ₹0 | ₹0.01 |

The current cart initializer clamps a balance above its initial value. Consequently ₹25.50 becomes ₹25.50 in that cart response, whereas ₹25.49 still becomes ₹25 and ₹0.01 is rejected as having no balance. The standalone voucher check and historical conversion use the stored balance without this clamp. Thus an admin issuing ₹25.49 can create a voucher displayed and converted as only ₹25, despite a ₹25.49 issuance history.

The user explicitly approved “Use exact paise values” after reviewing this discrepancy. The rewrite therefore uses the exact validated two-decimal amount for the ordinary voucher's current value, initial value and issuance history by default. Keep generic coupon and purchased gift-card semantics unchanged: retain the physical INT coupon shadow field and its native rounding, and make the global issuance path explicitly copy the exact `initial_val` into the ordinary voucher rather than the rounded `voucher_val`. This is an approved change to fractional redeemable values, not a response-identical query optimization. Integer inputs have identical values in all these fields. No production source patch or legacy schema change has been deployed.

This avoids widening `coupons.voucher_val` globally. Such a widening would affect generic percentage/fixed coupon initialization, validation and synchronization consumers; it is unnecessary for the narrower ordinary-voucher correction. The voucher itself, rather than merely a displayed response, must hold the exact amount. A durable issuance receipt proves coupon/voucher/history agreement under the selected profile.

## Validity, physical defaults and enum compatibility

Preserve ordinary vouchers as non-expiring. The source cart initializer and standalone check enforce dates only for `GIFT_CARD` when the corresponding feature is enabled. The POS display explicitly renders zero validity dates as “This Coupon Won't Expire.” A finite invented expiry interval would change that business behavior.

The original issuer omits many required coupon fields, coupon end date, voucher message and voucher start/end dates. Strict native fixtures already prove the source INSERT fails before completion. The replacement will supply each non-date physical field explicitly and use an explicit nullable-date representation for ordinary non-expiring voucher validity, paired with a review-only consumer compatibility patch that returns the legacy zero-date display sentinel for that ordinary non-expiring case. Existing gift-card dates remain unchanged. Generic coupon application excludes voucher type3. No legacy ALTER belongs in the automatic rewrite migration.

The source issuance classification `GV_ADD` is absent from both the verified MySQL `gift_voucher_history.platform` ENUM and API-v2 `GiftVoucherPlatformTypes`. The correction must add the classification to both definitions; it must not silently substitute `MISC_COMPENSATION`. The source's `added_user=0` is replaced with the actual authenticated operator in the new immutable issuance provenance. Code uniqueness is enforced by the existing voucher unique index plus a rewrite-owned command binding, without a nonunique `SELECT coupon WHERE code` race.

## Historical conversion and current outage

The active POS wrapper is `order/views.py:4554` and route `order/urls.py:86`. It calls `gift_voucher_to_tss_money`, but the pinned API-v2 no longer registers that endpoint. Commit `51107a870c56928cad88f181dd6806a1f5539a31` (2026-10-29), an ancestor of pinned `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`, explicitly removed it.

The actual predecessor is `02bfa5902f06faa5e648c4d5ad64c2e72646853e`. Its `controllers/GiftVoucherController.py:21` SHA256 is `c885119baa3a3af684babb8949abae7ac8e907cb57f831556eebb09238ed8b6e`. That implementation:

- requires authenticated API customer context, active voucher, matching nonempty recipient, positive balance and platform online/both;
- enforces dates only for enabled gift cards;
- sets an ordinary voucher balance to zero, retaining its active status;
- zeroes and deactivates a gift card only inside the branch where a PIN is required and PIN checking is enabled; a no-PIN/disabled-PIN gift card therefore retains its value while being credited, permitting repeated conversion;
- commits the voucher mutation, voucher ledger, and wallet/reward ledgers in separate stages; an error can leave partial committed financial state;
- debits `gift_voucher_history` with `MISC_COMPENSATION`, credits `tss_money_history` with `MISC_COMPENSATION`, additionally credits `reward_point_history` with `CASHBACK_EARNED`, then increments only `users.tss_money`; it does not change the cashback balance;
- records voucher history with `round(value*100)/100`, but credits raw floating voucher value to Money; fractional-paisa data can disagree;
- carries voucher end date to Money expiry only when Money expiry is enabled, otherwise returns the zero-date sentinel.

The predecessor's API auth middleware rejects missing customer authentication, while the POS wrapper supplies no Authorization header. This is another version/deployment mismatch; discovering the old method does not establish that the current POS wrapper succeeds against that API deployment.

The new conversion uses one writer transaction, current checked-in checkout/customer/contact proof, an immutable operation UUID and durable receipt, shared wallet/customer then collection then voucher locks, and exact coherent cents. It preserves separate cashback, writes the proper GV and Money histories, and consumes a converted gift card in every supported branch. Correcting the duplicate reward ledger and the repeated gift-card credit vulnerability is explicit; source vulnerabilities are not parity goals. Current endpoint absence remains documented rather than being treated as a verified live provider contract.

## PIN budgets and current lookup concurrency

Pinned API-v2 `settings.py:502–503` defaults `GC_PIN_LIMIT=6` and `GC_PIN_LIMIT_EX=86400`. The actual `validate_gc_pin` refreshes its Redis TTL on each wrong attempt; a blocked attempt does not refresh it. The source-consumer oracle executes that literal function with an in-memory expiring Redis recorder and selects only those two public default assignments from settings; it never imports settings or loads credentials. The rewrite preserves that six-attempt/86400-second sliding policy across operators and their independent checkout sessions. Durable wrong-PIN command receipts additionally prevent a lost reply or exact replay from consuming another guess or extending the TTL. Correct and wrong concurrent intents cannot credit a voucher twice.

`GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT` defaults 6 and permits 1–6; `GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT_EX` defaults 86400 seconds and permits 86400–604800. Those bounds allow explicit strengthening without weakening the source default. Actual production feature flags still require acceptance; the source default `GC_PIN_STATUS=0` is not evidence of deployed configuration. New-app PIN checks default on.

Customer lookup reads at most two candidate IDs from the primary reader. The writer then locks the selected customer by PK before its first consistent email-identity read, avoiding a concurrent share-to-exclusive lock upgrade. Actor reads are locking current reads, so they do not establish an earlier REPEATABLE READ snapshot. Twenty parallel real-MySQL lookups complete without changing any balances. Authoritative contact/actor version and identity rechecks bind the short-lived selection; financial mutation rechecks the selection under the same writer locks.

## Legacy gift-card funding boundary

New funded gift cards require the existing immutable `pos_rewrite_gift_card_issuances` proof and native source hash. A later batch block does not confiscate already funded value. No verified legacy backfill exists for pre-proof cards: old settlement could publish paid/placed before asynchronous wallet/stock completion, so payment status4 plus `has_products.gift_voucher_id` alone does not prove once-only funding. Such cards remain an explicit reconciliation gate; no caller boolean, batch flag or status-only read manufactures a proof. A reviewed reconciliation requires independently complete original payment/funding evidence, an exact one-HP/voucher/code/value/customer relation, and absence of earlier funding or consumption anomalies, with source order/HP → MUser → sorted collection → voucher lock order.

## Verification and runtime hooks

`registerGlobalVouchers(app,config,db,options,{customerOtp})` and `readGlobalVoucherOptions()` are exported by `src/modules/global-vouchers/index.ts`. The automatic migration is `src/modules/global-vouchers/migration.sql` and contains rewrite command/selection/PIN tables only. The source ALTER and consumer patches remain separate review-only files under `compatibility/upstream/global-vouchers`; they have not been deployed. There is no provider send or background worker in this slice.

Native fixtures require `GLOBAL_VOUCHERS_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_global_vouchers_test`, reject nonlocal URLs, create a unique temporary database, reproduce verified physical types/defaults/collations, and drop only that fixture database. Source patches are hash-checked and dry-applied in temporary copies only. Tests cover exact stored values, old-source rounding/clamping, bigint audit IDs, atomic rollback, 20-way replay, cancellation/dispatch races, actual secure OTP proof in the money transaction, shared PIN budgets and lookup concurrency. The six Chromium workflows exercise real issuance/conversion components with synthetic API responses, reload/GET recovery, no duplicate credit, separate failed-cart-refresh recovery, rejected PIN recovery and actor-switch fencing. Local journal data contains opaque scope/command IDs and issuance amount; it never stores voucher code, PIN, customer email/name or receipt.

## Evidence and limits

POS source pin: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, global issuer `core/views.py:1483`, form/click handler `core/templates/special_permission/index.html:269,643`. Current API consumers: `controllers/cart/initializers/MetaInitializers.py:280` and `controllers/GiftVoucherController.py:13`. Physical schema: `evidence/mysql-global-benefits-schema.json` plus the separately verified Money history metadata. The existing literal global-benefit oracle/native checks live in `tools/checkout/benefit_oracle.py` and `tests/checkout/global-benefit-source.mysql.integration.test.ts`.

No historical MySQL report fallback is introduced. This slice performs current lookups, mutations and exact operation reconciliation; it does not invent an all-history reporting endpoint. Shared external wallet/voucher writer lock compatibility and reviewed source consumer/legacy-schema deployment remain release gates. The exact-value business decision is approved. Native synthetic fixtures do not certify live cross-service rollout.
