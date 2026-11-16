-- REVIEW ONLY: no DDL was applied. A separately authorized publisher must own deployment/CDC.
-- Example uses a distinct curated prefix inside the already authorized raw dataset.
-- The supplied report reader remains read-only and does not create or populate this table.
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_reporting_customer_feedback_facts_v1` (
  feedback_id INT64 NOT NULL,
  store_row_id INT64,
  order_id INT64 NOT NULL,
  customer_id INT64,
  store_id INT64,
  question_id INT64,
  feedback STRING,
  feedback_date DATETIME,
  order_date DATETIME NOT NULL
)
PARTITION BY DATE(order_date)
CLUSTER BY store_id,customer_id,order_id,feedback_id
OPTIONS(require_partition_filter=TRUE);

-- Exact row grain: one feedback × each source order_store row, or one null store row.
-- The publisher must propagate updates/deletes/order ownership/store-association changes.
-- Do not deduplicate shared order/store IDs or freeze current question/customer text here.
SELECT nf.id AS feedback_id,os.id AS store_row_id,o.id AS order_id,o.user_id AS customer_id,
  os.store_id,nf.question_id,nf.feedback_answer AS feedback,nf.created_at AS feedback_date,
  o.created_at AS order_date
FROM `tssgcp2025.tss_mysql_raw_layer.tss_nps_feedback` nf
LEFT JOIN `tssgcp2025.tss_mysql_raw_layer.tss_orders` o ON o.id=nf.order_id
LEFT JOIN `tssgcp2025.tss_mysql_raw_layer.tss_order_stores` os ON os.order_id=o.id
WHERE nf.order_id>0 AND o.created_at IS NOT NULL;
