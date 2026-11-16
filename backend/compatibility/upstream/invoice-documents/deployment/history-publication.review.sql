-- REVIEW ONLY. Not executed by any application, test, or read-only SA.
-- A separate authorized publisher must populate and reconcile these immutable
-- generations from the actual source snapshot + verified complete CDC position.
-- BQ CDC apply timestamps alone MUST NOT set source_complete=TRUE.
-- Prefixes stay inside the observed reader-authorized dataset. No assertion that
-- these resources already exist. Cluster/publishing cost must be qualified.
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_invoice_orders_v1` (
  generation_id STRING NOT NULL,
  customer_id STRING NOT NULL,
  order_id STRING NOT NULL,
  order_status STRING NOT NULL,
  payment_status STRING NOT NULL,
  updated_at DATETIME NOT NULL
) CLUSTER BY customer_id, order_id, generation_id;

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_invoice_customer_counts_v1` (
  generation_id STRING NOT NULL,
  customer_id STRING NOT NULL,
  source_rows INT64 NOT NULL,
  warehouse_rows INT64 NOT NULL,
  source_hash STRING NOT NULL,
  warehouse_hash STRING NOT NULL,
  source_eligible_count INT64 NOT NULL,
  warehouse_eligible_count INT64 NOT NULL
) CLUSTER BY customer_id, generation_id;

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_invoice_publications_v1` (
  generation_id STRING NOT NULL,
  contract_version STRING NOT NULL,
  source_table STRING NOT NULL,
  source_complete BOOL NOT NULL,
  source_snapshot_id STRING NOT NULL,
  source_snapshot_at TIMESTAMP NOT NULL,
  source_cdc_watermark TIMESTAMP NOT NULL,
  published_at TIMESTAMP NOT NULL,
  source_rows INT64 NOT NULL,
  warehouse_rows INT64 NOT NULL,
  source_hash STRING NOT NULL,
  warehouse_hash STRING NOT NULL
) CLUSTER BY source_table, contract_version, generation_id;

-- Publisher-side warehouse reduction at ONE immutable generation. Bind the
-- generation; never substitute current raw rows from a different generation.
-- The excluded statuses are the exact pinned online invoice COUNT predicate.
SELECT generation_id,customer_id,COUNT(*) AS warehouse_rows,
  COUNTIF(order_status NOT IN('0','4','7','10','15','17','22','24','36')) AS warehouse_eligible_count
FROM `tssgcp2025.tss_mysql_raw_layer.pos_invoice_orders_v1`
WHERE generation_id=@generation
GROUP BY generation_id,customer_id;
-- The above COUNT does not produce source_rows/source_eligible_count/source_hash.
-- Obtain them independently from the same authoritative source checkpoint.
-- Hash canonical rows in numeric order_id order using the documented stream;
-- publish only after per-customer + global count/hash equality, uniqueness and
-- tombstone/CDC conservation hold. Source completion is an external attestation.
