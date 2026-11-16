-- REVIEW ONLY: no DDL in this artifact was applied.
-- Proposed dataset tssgcp2025.pos_reporting (asia-south1) requires separate approval.
-- Readers remain read-only. A separate CDC/publisher identity must populate/update these tables.
-- Every customer_bucket is MOD(the current owning orders.user_id,1024), not MOD(order_id,1024).

CREATE TABLE IF NOT EXISTS `tssgcp2025.pos_reporting.customer_history_orders_v1` (
  customer_bucket INT64 NOT NULL,
  id INT64 NOT NULL, user_id INT64 NOT NULL,
  order_amt FLOAT64, created_at DATETIME, order_status INT64
)
PARTITION BY RANGE_BUCKET(customer_bucket, GENERATE_ARRAY(0,1024,1))
CLUSTER BY user_id,id
OPTIONS(require_partition_filter=TRUE);

CREATE TABLE IF NOT EXISTS `tssgcp2025.pos_reporting.customer_history_order_stores_v1` (
  customer_bucket INT64 NOT NULL,
  id INT64 NOT NULL, order_id INT64 NOT NULL
)
PARTITION BY RANGE_BUCKET(customer_bucket, GENERATE_ARRAY(0,1024,1))
CLUSTER BY order_id,id
OPTIONS(require_partition_filter=TRUE);

CREATE TABLE IF NOT EXISTS `tssgcp2025.pos_reporting.customer_history_lines_v1` (
  customer_bucket INT64 NOT NULL,
  id INT64 NOT NULL, order_id INT64 NOT NULL,
  prod_id INT64, sub_prod_id INT64, qty INT64, price FLOAT64
)
PARTITION BY RANGE_BUCKET(customer_bucket, GENERATE_ARRAY(0,1024,1))
CLUSTER BY order_id,id
OPTIONS(require_partition_filter=TRUE);

CREATE TABLE IF NOT EXISTS `tssgcp2025.pos_reporting.customer_history_nps_v1` (
  customer_bucket INT64 NOT NULL,
  id INT64 NOT NULL, order_id INT64 NOT NULL,
  feedback_answer STRING
)
PARTITION BY RANGE_BUCKET(customer_bucket, GENERATE_ARRAY(0,1024,1))
CLUSTER BY order_id,id
OPTIONS(require_partition_filter=TRUE);

-- Read-only row-preserving backfill definitions. No INSERT/MERGE/EXPORT is run here.
-- The owner must implement updates/deletes and re-parented order/customer changes, not append-only copies.
SELECT MOD(user_id,1024) AS customer_bucket,id,user_id,order_amt,created_at,order_status
FROM `tssgcp2025.tss_mysql_raw_layer.tss_orders`;

SELECT MOD(o.user_id,1024) AS customer_bucket,os.id,os.order_id
FROM `tssgcp2025.tss_mysql_raw_layer.tss_order_stores` os
JOIN `tssgcp2025.tss_mysql_raw_layer.tss_orders` o ON o.id=os.order_id;

SELECT MOD(o.user_id,1024) AS customer_bucket,hp.id,hp.order_id,hp.prod_id,hp.sub_prod_id,hp.qty,hp.price
FROM `tssgcp2025.tss_mysql_raw_layer.tss_has_products` hp
JOIN `tssgcp2025.tss_mysql_raw_layer.tss_orders` o ON o.id=hp.order_id;

-- Dedicated numeric-behavior input: discard comment text, retaining exact source numeric-prefix semantics.
-- Do NOT reuse this projection as the general NPS narrative/feedback report input.
SELECT MOD(o.user_id,1024) AS customer_bucket,nf.id,nf.order_id,
  CASE WHEN nf.feedback_answer IS NULL THEN NULL
    ELSE COALESCE(REGEXP_EXTRACT(nf.feedback_answer,r'^[\x09-\x0d\x20]*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)'),'0')
  END AS feedback_answer
FROM `tssgcp2025.tss_mysql_raw_layer.tss_nps_feedback` nf
JOIN `tssgcp2025.tss_mysql_raw_layer.tss_orders` o ON o.id=nf.order_id;
