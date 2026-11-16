# Customer behavior history

Baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`,
`users/views.py:AjaxUserbehaviourView` (804–1009). This slice implements historical
behavior display. Current membership, wallet, vouchers and app activity belong
to `customer-insights`; product feedback entry is a separate feature.

## API and authority

`registerCustomerHistory(app,config,db)` exports two private, uncached GET routes:

- `/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-history`
  accepts `limit` (1–100, default 25) and optional `returnBefore`.
- `/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-orders/:orderId/lines`
  accepts `limit` (1–100, default 50) and optional `before`.

The customer is derived from the authorized current checkout, never an email or
caller-supplied customer override. The shared writer-current checkout/check-in
authority and active/unblocked customer are captured before and after BigQuery.
A changed customer, checkout version, operator/store authority or blocked
customer prevents delivery of the result. SQL transactions finish before the
external query starts; no SQL lock is held over HTTP. `X-Operator-ID` must match
the authenticated current operator. Each route declares a static resource trace.
There is no body/query/answer/contact/token logging and no historical MySQL fact
fallback.

The history response contains `customerId`, `checkoutVersion`, `reader:bigquery`,
`fetchedAt`, summary metrics, at most five recent orders and a paged returned-order
list. Returned rows contain a first 20 item-name prefix, full `itemCount` and
`hasMoreItems`. The separate lines route exposes every HP occurrence through
paging, including repeated SKUs/names. Counts and IDs remain decimal strings;
amounts and NPS are finite numbers. Cart, pay amount, customer contacts and raw
survey answer strings are excluded. All inputs and warehouse DTOs use strict
runtime schemas.

Both continuation tokens are opaque HMAC-SHA256 proofs, at most 744 characters:
`base64url(JSON([1,purpose,captureBinding,anchorId])).base64url(signature)`.
Purposes are `orders` and `lines:<orderId>`. The binding covers operator, store,
counter, checkout, customer and checkout version. Signatures use canonical
base64url and constant-time comparison. Another customer/checkout/version/order
or a modified token is rejected before BigQuery work. Rows are strictly ID-desc
below their anchor. Tokens do not freeze source time or a CDC generation; each
page reauthorizes and captures fresh writer `NOW()`.

## Source behavior preserved

| Source behavior              | Implementation                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifetime exclusive savings   | Current effective product/parent price × HP quantity minus HP price; statuses 0/4/7/10/17/22 excluded; absent product contributions ignored.                                                                                                 |
| Approximate numeric rounding | Source FLOAT/DOUBLE round-to-even exact halves retained; BigQuery's default half-away rounding alone is insufficient.                                                                                                                        |
| Total/store/online count     | Preserve `orders LEFT JOIN order_stores` multiplicity. Each eligible order contributes `max(1,storeRows)` total and every store row to store count. Exclude statuses 0/17; online is the difference.                                         |
| Last 30 days                 | Strict `created_at > source NOW() -30 days`, statuses 0/17 excluded. The writer supplies native MySQL wall-clock `NOW()` text rather than assuming a timezone for DATETIME.                                                                  |
| Cancelled/returned counts    | Separate status 4/status 6 order counts.                                                                                                                                                                                                     |
| NPS                          | Preserve MySQL numeric-string prefix conversion; nonnumeric nonnull answers contribute zero, no feedback yields null. SUM/count matches source AVG arithmetic on native vectors, including 19/6. Raw answer strings never leave the gateway. |
| Last five orders             | All statuses; order by source `DATE(created_at)` descending.                                                                                                                                                                                 |
| Returned items               | HP.prod_id → products.product, with duplicate HP/SKU occurrences retained. This differs from the effective-SKU savings join.                                                                                                                 |

The pinned source has no defined order among same-day recent orders, and its
returned-order/item ORM queries have no explicit ordering. The candidate uses ID
descending as an explicit stable pagination/tie policy; this is not a claim that
an undefined source tie order can be reproduced. Product FK is nonnullable in
the pinned HasProduct model, matching the returned-name INNER JOIN. Current
product prices/names are mutable dimensions, consistent with the source lookup;
this display is not frozen original invoice pricing.

Security corrections: email interpolation and unrestricted customer selection
are replaced with bound IDs and current checkout authority. The source catches
some failures and silently displays zero metrics; the candidate returns a
sanitized unavailable/data-contract response instead of fabricating history.
Large returned lists remain accessible through pagination rather than one
unbounded response or an N+1 query per order.

## Warehouse cost and deployment

The observed five raw relations are explicitly mapped in `sql.ts`. Actual
metadata-only dry runs exceed the unchanged 1 GB execution budget. The gateway
estimates each request before running it and refuses an over-budget query with
`CUSTOMER_HISTORY_PROJECTION_REQUIRED`; it neither increases the cap nor falls
back to MySQL.

`customer-history-query-proposals.md` and
`customer-history-projection-review.sql` provide the separate, review-only
customer-bucket partitioned deployment contract and exact minimal SELECTs.
The optional `customer-bucket-v1` layout requires all four configured fact
projections; retaining the raw fact names fails readiness. Products retain the
current source dimension. No proposed dataset/table/DDL was applied with the
read-only account. Post-deployment cost, CDC/backfill/update/delete propagation
and real source comparisons remain deployment acceptance requirements.

Raw CDC may lag, and independently merged tables do not establish a common
source snapshot. `fetchedAt` is response retrieval time, not an exact data-as-of
timestamp. No financial publication, receipt-conservation or production parity
claim is made by this nonfinancial display.

## Evidence and reproducibility

- `tests/customer-history`: 18 passing checks. Seven native MySQL checks use
  guarded randomized local schemas and verified physical types/collations;
  four SQL builders execute the exact pinned source AST with only the local NPS
  schema qualifier changed. ORM-derived count/recent/returned projections are
  explicitly reconstructed with the candidate ordering policy. Two additional
  native authority checks prove revocation/customer/version guards and released
  locks over external work; eight service checks and one HTTP check cover
  cursor, actor, input, scope, cost and partition-readiness boundaries.
- `parity/evidence/customer-history/native-fixtures.json` contains only generated
  local vectors and their native results. Physical Latin1 feedback constraints
  are retained; an unsupported fullwidth-digit input is rejected rather than
  changing the fixture collation.
- `tools/customer-history/bigquery-fixtures.ts` executed 24 SELECTs containing
  only generated CTE literals, never real customer rows. Five native vectors run
  against both layouts, with full history/HP comparisons, duplicate-item
  continuation checks and the exact review-file NPS prefix projection. All 10
  layout cases and their continuation checks passed. Evidence is atomically saved
  in `parity/evidence/customer-history/bigquery-fixtures.json`.
- `tools/customer-history/dry-run.ts` performs metadata-only raw query validation
  and saves cost estimates in `evidence/bigquery-customer-history-dry-run.json`.
  It cannot read live row payloads.
- `tools/customer-history/tsconfig.tests.json` is the strict owned code/test/tool
  check. No skill, parity gate or test result grants live deployment authority.

The actual SDK serializes explicitly typed DATETIME plain strings as SQL NULL
without its value wrapper. Direct SDK tools and the estimator therefore use
the shared `normalizeWarehouseParameters` helper, as does the runtime warehouse
client. The executed strict 30-day vector exposed and verifies this boundary.
Fixture equality is bounded source-derived/native/BQ evidence, not a complete
Django/production database certification.
