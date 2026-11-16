# Proposed global wallet corrections

Status: **the user approved corrected wallet behavior in this session**. The Node atomic writer and durable browser workflow now implement that decision. Activation remains disabled without the explicit corrected-wallet and shared-writer locking contracts. The source repositories, production database and legacy source patch are unchanged.

## Concrete decision

The approved profile adjusts TSS Money without clobbering cashback, writes its proper ledger, and binds Points fields to their intended inputs. The unsafe original profile is retained only as an isolated oracle. Unsupported `DONATION_POINTS` remains unavailable until its business meaning is explicitly mapped or its physical enum is changed; neither spelling is guessed.

| Action/field | Original source behavior | Proposed corrected behavior |
| --- | --- | --- |
| Money balance | `users.tss_money = old money + signed adjustment` | Preserve this arithmetic and its native FLOAT storage |
| Separate cashback | `users.cashback = new money balance`, even when cashback was unrelated | Leave cashback unchanged |
| Money audit | Write both `reward_point_history` and `tss_money_history` | Write only `tss_money_history`; cashback reward history is unchanged |
| Money platform | Feed Money platform into both tables; many values are absent from reward-history ENUM | Validate the source Money choices against the actual Money ENUM |
| Points order ID | Store `platform_p` in BIGINT `order_id` | Store validated `order_id_p` |
| Points product ID | Parse `product_id_p` but omit it from the history insert | Store validated `product_id_p` in physical `prod_id` |
| Points platform | Store numeric `order_id_p` as enum platform | Store validated `platform_p` |
| Points reason | Store numeric `product_id_p` as comment | Store the selected `reason_p` |
| Point platform `DONATION_POINTS` | Source dropdown offers a value absent from the physical enum | Explicit rejection; do not substitute `DONATION_POINTS_1` or `DONATION_CASHBACK` |
| Debit earning allocation | Binary-float FIFO by `created_at`, using `round(value*100)/100`; silently succeeds with incomplete histories | Preserve coherent source arithmetic; reject incomplete/corrupt history before mutation, with deterministic ID ordering for equal timestamps |
| Negative/unsafe balance | Source can overdraw or lose cents in legacy FLOAT | Reject overdraft and a native FLOAT rounding loss of at least half a paisa |
| Input fields | Interpolated SQL, arbitrary free text, no upper-bound enforcement | Strict typed fields, source reason/platform choices, exact positive two-decimal amount capped at the source UI maximum ₹99,999; parameterized ORM writes |
| Earning expiry | Empty date can reach strict DATETIME and fail after earlier autocommits | Explicit valid manager-supplied earning date; an unset non-earning debit expiry can be SQL NULL |
| Audit trace | Recipient email/customer name in free-text activity log | Opaque customer/operator/operation references plus structured amount/platform/reason; no PII in application logs or new activity text |

For example, with Money ₹100 and cashback ₹7, adding ₹25.50 currently stores Money ₹125.50 **and cashback ₹125.50**. The proposal stores Money ₹125.50 and leaves cashback ₹7. It does not repair existing balances or historical duplicate reward records silently.

## Pinned executable evidence

- Source: `backend-pos-web` commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, `core/views.py` SHA256 `20f9910156aa3c427df759bdd26f4d19992a91f0a1ea1df915fa98eb3b2de349`.
- Review patch: `wallet-correction.patch`, SHA256 `800758e0763efddfe1cacdc5a9a55022d3209a9bdbb1599f76a5b86f24e30730`.
- Candidate source SHA256: `09bcd44183a1c5d0df5d22734056c0638e0467ccfe12c06d93d90f9de7b9307a`.
- `tools/checkout/benefit_oracle.py` AST-extracts and executes the literal original POST methods using an in-memory intent recorder. It checks original/candidate hashes, never imports Django or connects to SQL, and never rewrites fixtures during verification. The candidate patch is applied in memory.
- `src/modules/checkout/benefit-adjustments/policy.ts` is the pure approved planner. It preserves coherent source FLOAT64/cent/FIFO arithmetic and returns explicit changes; the atomic repository applies them while holding the customer row lock.
- `tests/checkout/global-benefit-policy.test.ts`: four checks, including 320 deterministic original/candidate FIFO vectors, exact field changes, invalid input, unsupported platforms and integrity guards. The original Points flow can produce invalid SQL; matching its in-memory FIFO does not claim original SQL success.
- `tests/checkout/global-benefit-source.mysql.integration.test.ts`: six actual isolated MySQL checks using verified physical columns/defaults and strict/NO_ZERO_DATE mode. They prove original cashback overwrite, wrong-ledger ENUM failure, Points BIGINT binding failure, corrected coherent field values, unsupported platform/empty date failures, Gift Voucher omissions, and native DOUBLE-history/FLOAT-balance correspondence.
- Metadata: `evidence/mysql-global-benefits-schema.json` plus existing `mysql-extra-schema.json`. No live row values were read or written.

Commands from `backend`:

```sh
npx --yes node@24.22.3 node_modules/typescript/bin/tsc --noEmit --project tools/checkout/global-benefits.tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npx --yes node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout/global-benefit-policy.test.ts tests/checkout/global-benefit-source.mysql.integration.test.ts
```

The native harness refuses any nonlocal connection or other schema name, creates its own unique fixture database, and never executes the source's hardcoded `tss.coupons` qualifier. It drops only that fixture database.

## Production implementation boundary

The actual writer now uses one user-row-locked transaction covering current internal role1–3 authorization, unambiguous active customer, request-bound durable idempotency, exact balance/history rereads, ledger/FIFO mutations and PII-free audit. Concurrent receipt replays use locking current reads of the original ledger and allocation evidence, avoiding an old REPEATABLE READ snapshot after waiting for another transaction. The browser retains one immutable command across tabs/reloads and requires an explicit exact retry after unknown outcomes. All other wallet writers must honor the same user-row lock contract; stale external read/overwrite writers remain a deployment gate. A missing/corrupt history becomes an explicit repair action, not a hidden write-off.

The patch describes only the approved financial differences. It does **not** make the old interpolated SQL, missing transaction or authorization behavior safe to deploy. The replacement uses parameterized ORM operations; it does not dispatch that old SQL. See `parity/wallet-adjustments.md` for activation flags and remaining integration gates.

## Gift Voucher is a separate decision

The original global form supplies email and amount, generates `GFV<timestamp><one digit>`, and inserts a coupon, gift voucher and history row without a transaction. Current physical metadata shows many omitted NOT NULL/no-default fields, including required validity dates. Its `GV_ADD` history platform is absent from the actual enum. Native fixtures prove these failures; no implicit empty dates or enum aliases are invented.

Source API-v2 `GiftVoucherController.GiftVoucherCheck.on_post` enforces active status, recipient email, positive balance and online platform; `make_gift_voucher` enforces the corresponding POS/online scope, recipient, status and balance. Both enforce dates only for `GIFT_CARD` when enabled. Ordinary `GIFT_VOUCHER` dates are not expiry-enforced; the standalone check returns `end_date` as `voucher_validity`, while cart initialization removes dates from its result.

A gift-issuance candidate therefore needs explicit validated manager-supplied start/end dates and a reviewed complete physical field mapping. An expiry-enforcement claim also needs a separate reviewed source redemption patch. Code uniqueness, positive integer coupon value versus DOUBLE voucher value, allowed platform, recipient scope and the explicit `GV_ADD` history classification need verification. Keep the returned voucher/code behavior; never quietly turn missing dates into an invented validity period.
