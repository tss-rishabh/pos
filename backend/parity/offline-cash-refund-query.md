# Candidate per-HP refund update: explicit financial semantics decision

The user explicitly approved corrected per-line refund semantics after reviewing this concrete candidate. It changes stored per-line refund amounts when one product appears in multiple `has_products` (HP) rows with different allocated refunds, so it is **not a response-identical query optimization**. This approval is an explicit exception to the original rule9 response-equality condition for this defect. Root is integrating the validated correction into the transient template projection with an explicit refund-allocation contract and source-patch hash, while retaining nonnegative/cent/total guards. This does not establish that the shared or production API-v2 source was patched, deployed or backfilled. The artifact preparation itself changed no sibling source, existing runtime or live database.

The source artifact is `backend-tss-api_v2@2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`, `controllers/OrderController.py`, SHA256 `821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad`. `amount_to_be_refunded_calculation` begins at3513; its UPDATE at3589 filters by order/product only, so each iteration overwrites every HP row with that product ID. The following audit INSERT already identifies the individual HP row. Source `_round2` and `_distribute_amount_to_be_refunded` calculate per-HP amounts correctly for the ordinary tested vectors; the broad UPDATE loses that allocation.

The tiny candidate adds the HP primary-key guard while retaining the existing order/product guards:

```diff
-                UPDATE has_products SET amount_to_be_refunded = {}, fraction_value = 0 WHERE order_id = {} and prod_id = {}
-            '''.format(amount_to_be_refunded, orderId, order_product['prod_id'])
+                UPDATE has_products SET amount_to_be_refunded = {}, fraction_value = 0 WHERE order_id = {} and prod_id = {} AND id = {}
+            '''.format(amount_to_be_refunded, orderId, order_product['prod_id'], order_product['id'])
```

It changes no refund arithmetic, rounding helper, audit INSERT, cancellation mapping, other field or schema. Primary-key selection can narrow the UPDATE, but that does not make its financial results equivalent to the original.

| Synthetic source input | Original stored HP refunds | Existing per-HP audit | Candidate stored HP refunds |
| --- | --- | --- | --- |
| Same product, raw1/2, paid3 | 2/2; total4 | 1/2; total3 | 1/2; total3 |
| Same product in reverse fetch order, raw2/1, paid3 | 1/1; total2 | 2/1; total3 | 2/1; total3 |
| Three same-product rows, raw1 each, paid1 | 0.34 each; total1.02 | 0.33/0.33/0.34; total1 | 0.33/0.33/0.34; total1 |
| Different products, raw1/2, paid3 | 1/2; total3 | 1/2; total3 | Unchanged |
| Same product, equal raw1/1, paid2 | 1/1; total2 | 1/1; total2 | Unchanged |

Amounts in the table follow the fixture fetch order; generated evidence arrays follow their listed HP IDs. Some multi-product permutations have an unchanged grand total while individual HP/audit values still disagree. The oracle checks each HP, not only the total. It preserves the source convention that the final payable line receives the rounding remainder; changing fetch order can therefore change which line receives a paisa. The candidate does not redesign that allocator or establish a new ordering rule.

Artifacts are under `compatibility/upstream/offline-cash-pricing/patches/`:

- `refund-by-hp-id.patch`: one file, two changed source lines.
- `refund-by-hp-id.manifest.json`: explicit disabled/non-identical status and before/after/patch hashes.
- `refund_query_candidate.py`: hash verification, `git apply --check`, application and reverse-check only inside a temporary copy; verifies exact resulting bytes, rejects extra files and checks that the real source remains unchanged.
- `refund-query-evidence.json`: generated differential results, not hand-entered expected totals.

Candidate controller SHA256 is `d8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18`. Patch SHA256 is `e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11`.

`test_source_refund_query.py` is a separate source-executed oracle. It extracts the actual three pinned refund functions, runs both original and temporary-patched functions, and executes their literal UPDATE/INSERT SQL only in separate in-memory SQLite databases. No source application startup, remote connection or network effect executes. It covers51 successful vectors: duplicate/order permutations, multiple duplicate groups, cent rounding, fractional inputs, different per-HP store discounts, unique/equal-duplicate cases, exact IDs above2^53 and protection of another order's row. Forty-seven vectors change stored refunds; four remain identical. The audit values/descriptors, cancellation mapping and every other HP field remain unchanged, while the candidate updates exactly one matching HP per iteration and matches the audit/target in these vectors.

Eight tests pass. An additional adversarial rounding case yields a negative last-line remainder even after the query fix. The candidate preserves that existing arithmetic and is not a general allocator repair. Alignment/total alone do not authorize a negative refund; the existing nonnegative/coherence guard must remain. This helper input is not evidence of eligibility as an accepted signed offline cash basket.

At the candidate verification checkpoint, the default compatibility provider rejected original inconsistent allocations with `SOURCE_REFUND_ALLOCATION_INCONSISTENT` and an unaccepted candidate source hash with `SOURCE_REVISION_UNVERIFIED`. The candidate/oracle slice did not change its SQL matcher, pinned hash, runtime, template code, provider flags or importer. Following the explicit user approval, root owns transient projection integration and the new contract/hash descriptors. The independent original-versus-candidate SQL evidence remains the comparison baseline. Source hashes, negative/cent/total validation, downstream acceptance and any actual upstream deployment/backfill remain separate gates; the artifact manifest's disabled state records that this patch tool never enables or deploys a provider.

Reproduce from backend:

```sh
python3 compatibility/upstream/offline-cash-pricing/patches/refund_query_candidate.py
python3 compatibility/upstream/offline-cash-pricing/test_source_refund_query.py -q
python3 compatibility/upstream/offline-cash-pricing/test_source_refund_query.py --report
```

This is SQL selection/source-function evidence, not a MySQL driver/physical numeric-type/plan test, deployed data backfill, downstream response certification or complete refund/cancel/loyalty/provider workflow test. Actual MySQL acceptance and any accepted upstream rollout need separate review. No production performance or full legacy-route certification is claimed.
