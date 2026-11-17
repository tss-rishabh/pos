-- REVIEW ONLY: independently populated source inputs, not native count exports.
-- The publisher does not fill these tables, fabricate CDC watermarks, select an
-- old MySQL history fallback, or use an empty table as completeness evidence.
-- Supply an approved consistent CDC materialization. All source status rows,
-- NULLs, future timestamps and exact signed BIGINT values must survive. Each
-- projection contains exactly one row for each current source orders.id.
-- No date partition/filter: the literal source predicates include future rows
-- and all earlier user orders. Both layouts must represent the same source set.
-- A materialized generation is usable ONLY after independent SHA-256/count/set
-- comparison to its genuine writer-origin native snapshot succeeds.
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_source_orders_by_customer` (
  id INT64 NOT NULL, user_id INT64, coupon_used INT64,
  order_status INT64, created_at DATETIME
)
CLUSTER BY user_id,coupon_used,id
OPTIONS(description='Independently sourced orders, customer-first layout for bounded literal all-order lookup');

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_source_orders_by_coupon` (
  id INT64 NOT NULL, user_id INT64, coupon_used INT64,
  order_status INT64, created_at DATETIME
)
CLUSTER BY coupon_used,user_id,id
OPTIONS(description='Same independently sourced orders, coupon-first layout; global usage includes every customer');

-- The append-only publisher selects coupon_used=@coupon, UNION ALL the selected
-- customer's rows whose coupon is NULL or differs. This exactly partitions the
-- native (user_id=@customer OR coupon_used=@coupon) set without deduplication.
-- Duplicated/missing/changed rows, asynchronous mixed views and incomplete CDC
-- fail candidate identity/five-fact comparison. Table creation alone proves none
-- of these invariants. Separate writer configuration is mandatory.
