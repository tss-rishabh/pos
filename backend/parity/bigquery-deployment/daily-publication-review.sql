-- LOCAL REVIEW ARTIFACT ONLY. No statement in this file was applied.
-- Proposed reporting dataset: tssgcp2025.pos_reporting, location asia-south1.
-- An authorized deployment principal must create/approve that dataset separately.
-- The supplied reports reader service account must retain SELECT/JobUser only.
-- Publishing requires the source/offline conservation algorithm in README.md;
-- creating empty tables is never proof of an empty or complete report.

CREATE TABLE IF NOT EXISTS `tssgcp2025.pos_reporting.daily_store_sales_rollups_v1` (
  generation_id STRING NOT NULL,
  offline_projection_contract STRING NOT NULL,
  store_id STRING NOT NULL,
  store_name STRING,
  location_code STRING,
  order_date DATE NOT NULL,
  order_source STRING NOT NULL,
  order_count INT64,
  qty INT64,
  revenue FLOAT64,
  membership_purchase_orders INT64,
  membership_orders_total FLOAT64,
  membership_revenue FLOAT64,
  tss_money_used_total FLOAT64,
  tss_points_used_total FLOAT64,
  pg_discount_total FLOAT64,
  gift_voucher_total FLOAT64,
  district_total FLOAT64,
  cash_total FLOAT64,
  total_online FLOAT64,
  pending_offline_orders INT64,
  banking_amount FLOAT64,
  footfall FLOAT64,
  target FLOAT64
)
PARTITION BY order_date
CLUSTER BY store_id, generation_id, order_source
OPTIONS (require_partition_filter = TRUE);

CREATE TABLE IF NOT EXISTS `tssgcp2025.pos_reporting.daily_store_sales_publications_v1` (
  generation_id STRING NOT NULL,
  store_id STRING NOT NULL,
  business_date DATE NOT NULL,
  row_count INT64 NOT NULL,
  row_hashes ARRAY<STRING>,
  published_at TIMESTAMP NOT NULL,
  cdc_watermark TIMESTAMP NOT NULL,
  source_position STRING NOT NULL,
  publication_state STRING NOT NULL,
  offline_projection_contract STRING NOT NULL,
  business_timezone STRING NOT NULL,
  source_baseline STRING NOT NULL,
  source_sql_sha256 STRING NOT NULL
)
PARTITION BY business_date
CLUSTER BY store_id, generation_id
OPTIONS (require_partition_filter = TRUE);
