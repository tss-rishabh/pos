# Customer history query/deployment proposal

Baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`,
`users/views.py:AjaxUserbehaviourView`. No live MySQL write/DDL, BigQuery DDL,
copy/load/export or source-row output was performed.

## Observed query cost

Metadata-only dry runs against the actual observed raw dataset estimate:

| Resource                        | Estimated bytes |  Existing cap | Result            |
| ------------------------------- | --------------: | ------------: | ----------------- |
| Customer summary/recent/returns |   3,217,272,021 | 1,000,000,000 | Execution refused |
| Customer/order HP expansion     |   1,506,392,998 | 1,000,000,000 | Execution refused |

Evidence: `evidence/bigquery-customer-history-dry-run.json`. These are estimates,
not billed bytes, observed latency or a production performance claim. Orders and
HPs are clustered by their own IDs, rather than user/order join keys. LIMIT does
not make a wide lifetime join inexpensive. The service estimates before query
execution, retains the configured server-side maximum bytes/time cap, and
returns `CUSTOMER_HISTORY_PROJECTION_REQUIRED` if that budget is exceeded. It
never increases the cap or falls back to MySQL for historical facts.

Clustering estimates are upper bounds and can exceed eventual block-pruned
work, while a filter on a partition key permits explicit partition pruning.
[BigQuery cost guidance](https://docs.cloud.google.com/bigquery/docs/best-practices-costs),
[partition pruning](https://docs.cloud.google.com/bigquery/docs/querying-partitioned-tables).

## Reviewable optimized layout

`customer-history-projection-review.sql` defines four proposed minimal tables,
row-preserving SELECTs and the partitioning contract. It is a local review
artifact and was not applied. The proposed reporting dataset must be approved
separately; the supplied reader account remains read-only. Its supplied grant
covers only `tss_mysql_raw_layer`, not the proposed `pos_reporting` dataset.
Using these example names therefore also requires an explicitly authorized
reader grant on the new reporting dataset. Alternatively, an approved publisher
may use separately prefixed curated tables inside the existing raw dataset and
configure their exact names; this tool neither creates them nor grants access.

All fact tables use `customer_bucket=MOD(orders.user_id,1024)` and integer-range
partitions 0–1023. Query predicates compare the stored bucket directly to one
bound constant, alongside customer/order predicates. This avoids guessed ID
ranges and gives dry runs a partition to prune before applying the byte guard.
Within each partition, orders cluster by user/id and child facts by order/id.
Products remain the current ID-clustered source dimension, preserving the
source's current parent-price/effective-SKU lookup rather than frozen historical
prices. Actual post-deployment estimates and source comparisons are still
required; bucket distribution and cost are not inferred from a local fixture.

Activation options after a separate authorized publisher deployment:

```dotenv
BQ_CUSTOMER_HISTORY_LAYOUT=customer-bucket-v1
BQ_CUSTOMER_HISTORY_ORDERS_TABLE=tssgcp2025.pos_reporting.customer_history_orders_v1
BQ_CUSTOMER_HISTORY_ORDER_STORES_TABLE=tssgcp2025.pos_reporting.customer_history_order_stores_v1
BQ_CUSTOMER_HISTORY_LINES_TABLE=tssgcp2025.pos_reporting.customer_history_lines_v1
BQ_CUSTOMER_HISTORY_FEEDBACK_TABLE=tssgcp2025.pos_reporting.customer_history_nps_v1
BQ_CUSTOMER_HISTORY_PRODUCTS_TABLE=tssgcp2025.tss_mysql_raw_layer.tss_products
```

Default layout stays `raw`. Selecting the partitioned layout with unchanged raw
fact names fails configuration readiness; it cannot claim nonexistent bucket
columns. Each query still performs its own budget estimate and server-side cap.

## Response conservation

The publisher must retain every source order status, every order-store row and
every HP/SKU occurrence. It must not deduplicate orders before source store-join
counts or collapse repeated item names. The source total is the joined count:
one order contributes `max(1,number_of_store_rows)` and contributes every store
row to the store count. Online count is their difference. Cancellations/returns
have their separate source status filters. Effective SKU and current parent
price affect savings; displayed returned names use HP.prod_id directly.

The NPS-only projection can discard free-text tails and retain the proven
numeric prefix or zero for a nonnumeric answer. NULL stays NULL. It must retain
every contributing answer, including nonnumeric zeroes; discarding those rows
changes the average. It is not the general feedback/narrative report table.

Updates, deletes, order ownership changes and product/parent changes need
explicit propagation. An append-only backfill or stale current product price
is not source equivalence. Preserve source FLOAT/DOUBLE scalar encoding and
business wall-clock DATETIME. New source fields or malformed/out-of-range data
must fail data-contract checks rather than silently become zero.

This is an observed-history display, not a financial authorization or a
transaction-consistent publication claim. Current customer/activity/check-in
and checkout authority are captured on the writer before and after external
query work; no SQL lock spans HTTP. Cash, refunds, wallet mutations, offline
receipt conservation and daily-report publication retain their own stronger
contracts and gates.
