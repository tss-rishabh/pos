# CSV tender and calculated bill: source evidence and review candidate

The original CSV importer records the sum of uploaded unit prices as tender even when API-v2 calculates a lower payable. It marks the order paid/delivered and records no change. The header, refund allocation, physical counter record and reports can consequently disagree. The current rewrite refusal remains selected. The new dual-value candidate is executable **review code only**; it cannot create a payment, refund, cash-out or financial completion.

## Pinned, executable evidence

Web source: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. API-v2: `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. Exact file hashes and twenty read-only reproducible source vectors are in `compatibility/upstream/legacy-order-imports/tender-profile/source-vectors.json`.

The oracle executes the literal CSV `OfflineOrderPunchInParseCSV.create_order`, `CalculationsWrapper.apply`, automatic birthday helper, coupon initialization/eligibility/percentage calculation, `PosOrder`, original constructors/defaults, refund allocator, `Helpers.complete_order`, `Helpers.transaction_logger`, native day-close/DSR SQL, day-close money normalization and cash-ledger functions. The new fixture uses verified physical MySQL columns/defaults, with the same explicitly reviewed private model/unset-date codec as the receiver candidate.

All eligibility/configuration/catalog/customer inputs are synthetic. Birthday cases represent an eligible existing member with an enabled, unused, valid offline birthday percentage coupon; they do not prove a live customer or store has that configuration. App5% cases exercise the supported conditional branch; the source calls it currently inactive. The native post-confirmation boundary is explicitly seeded as order1/payment1/HP PLACED. This task does not dispatch Go stock/coupon effects, mint membership provenance, create a real close or prove a production broker. Source task/mail/close requests are captured, never delivered. The tests compare both aggregate and per-unit HP modes and both cash and manual-other tenders.

## What each original stage actually records

1. `helpers/task_helpers.py:511–547` converts each CSV price to a Python float and adds it once per quantity. Neither the calculated bill nor discounts replace that accumulator. `:572–587` passes it to `complete_order` as both cash and cash received, or as manual-other. CSV SerialNo is not a payment transaction reference.
2. `CalculationsWrapper.py:419–447` applies eligible coupon/app discounts before GST. `:704–707` calculates `rounding_off = total - floor(total)` and floors payable. GST components are separately rounded, so the difference between uploaded tender and payable cannot be reconstructed from rounding plus coupon discount.
3. `OrderHelper.py:393–431` persists source `pay_amt`, `fraction_value`, coupon/asset fields; `:509–697` preserves HP gross price, discount, pre-GST and final-payable values. A conditional POS app discount can change payable while the source `app_discount`/header `ref_flag` remains zero.
4. Original `amount_to_be_refunded_calculation` targets the header payable, not the CSV counter tender. The already approved `pos-refund-per-hp-v1` patch preserves this target while fixing duplicate-SKU HP updates. Both profiles execute in the oracle; no new refund semantics are selected here.
5. `Helpers.complete_order(custom_date)` marks header payment4/order3, updates HP timestamps while leaving PLACED status, records exact original counter values, adds comments and transaction logs, and requests producer/membership/close-stale effects. It does not compute or return fractional change. Its ledger `pay_dict` contains the original CSV float tender.
6. Native `COLLECTION_SQL` sums `OrderStore.offline_payment`/actual online-other and has no paid-status filter. `compute_snapshot._money` quantizes via `Decimal(str(...))`; cash-ledger live/closed equations consume that cash, not `orders.pay_amt`. DSR instead computes online residual as `pay_amount - cash - district`, so it can show a negative or understated online value. Native evidence executes those exact functions/queries.

| Source case                  | CSV tender shown at 2dp | Header payable | Header fraction | Approved HP refund total | Original DSR online: cash / manual-other |
| ---------------------------- | ----------------------: | -------------: | --------------: | -----------------------: | ---------------------------------------: |
| Integer100                   |                  100.00 |         100.00 |            0.00 |                   100.00 |                            0.00 / 100.00 |
| 25.49 ×2                     |                   50.98 |          50.00 |            0.98 |                    50.00 |                            -0.98 / 50.00 |
| 249.50 ×3, GST5%             |                  748.50 |         748.00 |            0.50 |                   748.00 |                           -0.50 / 748.00 |
| App5%, gross100              |                  100.00 |          95.00 |            0.00 |                    95.00 |                            -5.00 / 95.00 |
| Birthday10%, gross100        |                  100.00 |          90.00 |            0.00 |                    90.00 |                           -10.00 / 90.00 |
| Birthday10%, 25.49 ×2, GST5% |                   50.98 |          45.00 |            0.89 |                    45.00 |                            -5.98 / 45.00 |
| Birthday100%, gross100       |                  100.00 |           0.00 |            0.00 |                     0.00 |                           -100.00 / 0.00 |
| App5%, mixed301.02, GST5%    |                  301.02 |         285.00 |            0.98 |                   285.00 |                          -16.02 / 285.00 |

For birthday/GST, source main subtotal45.88, pre-GST43.70 and tax2.19 yield45.89 before floor. Source rounding0.89 plus coupon5.10 is5.99, while tender minus payable is5.98. A proposed formula based on those source fields would misallocate a paisa.

Native float representation is retained separately: original0.10 ×10 records `0.9999999999999999`, while the existing source day-close/cash-ledger currency value is1.00. Interleaving `(0.10×5,0.20×5,0.10×5)` yields raw2.0; grouping the same products/quantities yields1.9999999999999998. Therefore the current aggregated plan alone cannot attest the exact original float addition sequence. Original ordered units/rows or an equivalent sealed source tender descriptor must accompany any future exact source receipt. This is not permission to manufacture sub-cent payments.

## Concrete unselected dual-value candidate

`src/modules/legacy-order-imports/tender-profile/domain.ts` exports strict `csvTenderEvidenceSchema`, `sourceTenderUnitSequenceHash(rows)` and `reviewOriginalCsvTender(evidence)`. `native.ts` exports `readNativeCsvTenderFacts(tx,orderId)` with current writer locks and exact native header/HP/counter hashes. These are internal read/review helpers, not source-proof or authorization substitutes. They have no registrar, activation flag or financial write path.

The candidate binds original operation/plan/order, ordered CSV rows, raw source tender, canonical declared currency, native source payable/fraction/coupon, approved refund total and actual cash/received/online-other fields. It rejects a changed sequence, wrong total/tender mode, invented change/provider value or unproved refund amount. It preserves exact native counter strings and the source header/refunds. It reports signed `declared tender - header payable` as unresolved surplus/shortfall; it never calls it rounding, revenue, a card payment, a refund or change. Even balanced evidence returns `financiallyExecutable:false`.

For a cash50.98/header50 row, the review proposal is:

| Field                                            | Original          | Review candidate                                         |
| ------------------------------------------------ | ----------------- | -------------------------------------------------------- |
| `orders.pay_amt` / HP refunds                    | 50.00 / 50.00     | Preserve50.00 / 50.00                                    |
| Cash / cash received                             | 50.98 / 50.98     | Preserve50.98 / 50.98                                    |
| Physical change / provider collection / cash-out | None              | None                                                     |
| DSR cash / online                                | 50.98 / -0.98     | 50.98 / 0.00                                             |
| Explicit unresolved surplus                      | Absent            | 0.98 for manager reconciliation                          |
| Automatic financial execution                    | Source marks paid | **Disabled** pending the decision and writer integration |

For manual-other50.98/header50, actual online-other stays50.98, and the candidate online value is50.98 rather than50.00. In either branch, adding signed tender/header difference to the original DSR online residual yields the actual recorded noncash amount. Counter tender is counted once; source line revenue/tax are unchanged. A shortfall, e.g. declared80/header100, remains80 collected plus20 unresolved, never an invented20 collection. Native matrix assertions verify these identities against source records.

## Business decision required before relaxing the existing gate

CSV unit prices are a historical declaration, not independent provider/cash-receipt evidence. In particular, original code does not prove whether the person actually paid50 or50.98, and it does not prove a current automatic birthday promotion existed on the historical sale date. The rewrite must not silently decide the customer's extra refund entitlement or reinterpret an uploaded price as another payment.

The concrete choices for review are:

- **Keep mismatches blocked for correction before financial import (recommended).** Preserve the original uploaded declaration and exact source calculation in a manager review record. Do not accept a new payment, change header/refunds, mark a mismatched row paid or issue an invoice automatically. A corrected import must retain auditable original references and prove the earlier command had no effects; it must never redispatch an unknown stage.
- **Permit the exact declared tender with an unresolved manager variance.** Preserve source header/refunds and collected tender, append the bound immutable variance, and correct DSR using actual counter channels. This requires deciding how that variance is resolved/refunded and ensuring pending/late collected money is visible in day-close/ledger. No automatic cash-out or enlarged refund is implied. Source paid-status behavior versus pending manager reconciliation must be explicitly selected, not inferred.

Neither choice is enabled by this commit. A nonzero difference is not just a deployment flag. The manager workflow, bound approval, source receipt extension, immutable variance journal/finance publication and final core execution remain CODE work after a reviewed policy. The current equality refusal remains intact.

## Minimal future integration contract

Before changing the financial core, compose a versioned, HMAC-sealed private source tender descriptor with operation/plan/order/native header+HP+counter hashes, original ordered CSV unit sequence, original float text, canonical declaration and exact original channels. Bind its selection to the existing authenticated actor/store/counter/date/price approval; do not trust browser body approver IDs. An immutable same-transaction variance record must survive later status/refund/contact changes and have one operation identity. Completion/read/replay must verify it before releasing the existing import hold. Unknown commands remain GET-only.

The finance/DSR bridge must correct only a source row whose exact imported proof is verified. Cash remains its existing native amount, DSR online delta is signed `declared tender - source payable`, and the unresolved variance is separately visible. Historical warehouse publication needs the same immutable proof/partition lineage; absence is not a zero fallback. Frozen day-close figures must not be silently edited. Source membership/upgrade/free-membership provenance, complementary/freebie spending, and screening ticket profiles remain separate CODE gaps, not covered by these vectors. The existing-member birthday fixture adds the source order attribute but does not activate/revoke membership. No screening or actor/proof guard composition was edited.

## Scoped checks

Use the pinned Node24 and existing locked Python runtime from `backend`:

```sh
node node_modules/typescript/bin/tsc -p tools/legacy-import-tender/tsconfig.json
node node_modules/vitest/vitest.mjs run tests/legacy-import-tender/domain.test.ts
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test node node_modules/vitest/vitest.mjs run tests/legacy-import-tender/source.mysql.test.ts
compatibility/upstream/offline-cash-pricing/.venv/bin/python -B compatibility/upstream/legacy-order-imports/tender-profile/prepare.py
compatibility/upstream/offline-cash-pricing/.venv/bin/python -B compatibility/upstream/legacy-order-imports/tender-profile/test_tender.py -v
```

Normal verification never rewrites vectors. Only explicit `prepare.py --write` updates the owned source artifact. Native tests create/drop a guarded fresh localhost schema. No protected source, live database, provider, mail, upload or deployment was changed.
