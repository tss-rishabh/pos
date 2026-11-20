# Customer behavior history

Baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`,
`users/views.py:AjaxUserbehaviourView` (804–1006). This slice implements historical
behavior display. Current membership, wallet, vouchers and app activity belong
to `customer-insights`; product feedback entry is a separate feature.

## Reader: MySQL for all dates (user decision, 20 November 2026)

Legacy reads every figure live from MySQL: four raw statements on
`connections['mysql_db']` (`users/views.py:877-893`, `:905-922`, `:924-943`,
`:967-984`) and ORM reads (`:945-965`, `:986-1006`). The rewrite previously read
only BigQuery raw CDC tables, so orders placed today were missing. The user decided
on 20 November 2026 (AGENTS.md, "Audit remediation decisions"; plan
`docs/plans/audit-remediation.md`, decision 1) that customer history at checkout
reads MySQL for all dates, as legacy does.

`gateway.ts` now runs every statement through the Drizzle builder on the
**primary reader** (`routeRead({kind:'interactive'})`), inside one read-only
REPEATABLE READ transaction, so the summary, recent orders and returned page come
from one snapshot. The BigQuery path is removed: `customer-history/sql.ts`,
`tools/customer-history/dry-run.ts`, the dry-run estimator and the
`BQ_CUSTOMER_HISTORY_*` settings are no longer read. (`backend/.env.example` still
lists the six `BQ_CUSTOMER_HISTORY_*` keys; that file is shared configuration and
is left to the primary agent.) `customer-history-query-proposals.md` is kept only as
the record of the superseded warehouse design.

## API and authority

`registerCustomerHistory(app,config,db)` exports two private, uncached GET routes:

- `/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-history`
  accepts `limit` (1–100, default 25) and optional `returnBefore`.
- `/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-orders/:orderId/lines`
  accepts `limit` (1–100, default 50) and optional `before`.

The customer is derived from the authorized current checkout, never an email or
caller-supplied customer override. The shared writer-current checkout/check-in
authority and active/unblocked customer are captured before and after the reader
query. A changed customer, checkout version, operator/store authority or blocked
customer prevents delivery of the result. The writer authority transaction
finishes before the reader transaction starts; no writer lock is held over the
history read. `X-Operator-ID` must match the authenticated current operator. Each
route declares a static resource trace. There is no body/query/answer/contact/token
logging.

The history response contains `customerId`, `checkoutVersion`, `reader:'primary'`
(was `'bigquery'`; the web/desktop client schema `frontend/src/pages/customer-insights/history-client.ts`
changed with it), `fetchedAt`, summary metrics, at most five recent orders and a
paged returned-order list. Returned rows contain a first 20 item-name prefix, full
`itemCount` and `hasMoreItems`. The separate lines route exposes every HP
occurrence through paging, including repeated SKUs/names. Counts and IDs remain
decimal strings; amounts and NPS are finite numbers. Cart, pay amount, customer
contacts and raw survey answer strings are excluded. All inputs and reader rows use
strict runtime schemas.

Both continuation tokens are opaque HMAC-SHA256 proofs, at most 744 characters:
`base64url(JSON([1,purpose,captureBinding,anchorId])).base64url(signature)`.
Purposes are `orders` and `lines:<orderId>`. The binding covers operator, store,
counter, checkout, customer and checkout version. Signatures use canonical
base64url and constant-time comparison. Another customer/checkout/version/order
or a modified token is rejected before any reader query. Rows are strictly ID-desc
below their anchor. Each page reauthorizes.

## Source behavior preserved

| Source behavior            | Legacy                                                                                                            | Implementation (`gateway.ts`)                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lifetime exclusive savings | `users/views.py:877-893`, `IFNULL(round(sum((pap.price*hp.qty)-hp.price),0),0)`, statuses 0/4/7/10/17/22 excluded | The same expression over the same joins (effective SKU, then parent price). MySQL's own approximate-value `ROUND` is used, so half-even rounding is identical by construction.                         |
| Total/store/online count   | `:924-943`, `orders LEFT JOIN order_stores`, statuses 0/17 excluded                                               | Same join and `COUNT(os.id)`/`COUNT(o.id)`; the store-row multiplicity is kept. Online is the difference.                                                                                              |
| Last 30 days               | `:905-922`, `created_at > NOW() - INTERVAL 30 DAY`, statuses 0/17 excluded                                        | Same predicate, evaluated with the reader's `NOW()` exactly as legacy evaluates it on `mysql_db`. (The writer-captured source time used for BigQuery is gone.)                                         |
| Cancelled/returned counts  | `:945-965`, `Order.objects.filter(order_statuses=4/6).count()`                                                    | Conditional counts on the customer's orders.                                                                                                                                                           |
| NPS                        | `:967-984`, `AVG(feedback_answer)` over `nps_feedback LEFT JOIN orders`                                           | Same `AVG` over the same join, so MySQL's string-to-number prefix conversion applies unchanged; no feedback yields `null`. Raw answer strings never leave the gateway.                                 |
| Last five orders           | `:986-1006`, all statuses, `DATE(created_at)`, ordered by it descending                                           | Same; ID descending is the explicit tie order. A zero/invalid DATETIME whose `DATE()` is not a calendar date is shown as `null`.                                                                       |
| Returned items             | `:950-965`, `HasProduct.objects.filter(order_id).values_list('product__product')`, `OrderStore...exists()`        | HP.prod_id → products.product (inner join, nonnullable FK), duplicate occurrences retained; `EXISTS` on `order_stores`. Names are a first-20 prefix per order via `ROW_NUMBER()`, with the full count. |

The pinned source has no defined order among same-day recent orders, and its
returned-order/item ORM queries have no explicit ordering. The rewrite uses ID
descending as an explicit stable pagination/tie policy; this is not a claim that
an undefined source tie order can be reproduced. Current product prices/names are
mutable dimensions, consistent with the source lookup; this display is not frozen
original invoice pricing. `get_no_of_gv_count` (`:895-903`) is not part of this
slice (customer-insights shows vouchers).

Security corrections: email interpolation and unrestricted customer selection
are replaced with bound IDs and current checkout authority. The source catches
some failures and silently displays zero metrics (`:821-838`); the rewrite returns
a sanitized error instead of fabricating history. Large returned lists remain
accessible through pagination rather than one unbounded response or an N+1 query
per order.

## Evidence and reproducibility

- `tests/customer-history/mysql.integration.test.ts` (native MySQL 8.4, guarded
  randomized local schema built from the production DDL snapshot): for each of the
  five generated vectors it runs the pinned source statements from the golden
  `tests/golden/customer-history/mysql-integration.json` (unchanged) plus the
  reconstructed ORM projections, then runs the rewrite gateway on the same session
  and fixed `SET timestamp` NOW(), and requires equal output: summary, recent
  orders, every returned row, every HP line page, a mid-list `before` page and a
  foreign-customer `orderFound:false`. The vectors include same-day orders,
  order-store multiplicity, half-even rounding, NPS 19/6, 64-bit IDs and 23-line
  orders. 5 vectors passed on 20 November 2026.
- `tests/customer-history/service.test.ts`: cursor, actor, input, scope and data
  contract checks, and a check that the default gateway reads the `primary` reader
  in a read-only REPEATABLE READ transaction.
- `tests/customer-history/authority.mysql.integration.test.ts` and `http.test.ts`:
  revocation/customer/version guards around the read, and HTTP auth/trace checks.
- Web: `frontend/tests/customer-profile/browser.test.ts` (Chromium) with the
  `reader:'primary'` contract. Desktop macOS and Windows evidence for this change is
  left to the validation phase (standing work order).
- `parity/evidence/customer-history/native-fixtures.json` contains only generated
  local vectors and their native results. Physical Latin1 feedback constraints
  are retained.

This is bounded generated-fixture evidence, not a production database
certification.
