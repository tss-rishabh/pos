-- REVIEW ONLY. This is a separately authorized publisher deployment, never
-- executed by POS startup or the supplied reports-bigquery-reader identity.
-- Current metadata confirms the required marker raw table is ABSENT. Replicate
-- the actual tss.spiderman_screening_orders first; do not alias another table.
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_screening_counter_rows`(
 publication_date DATE,scope_shard INT64,customer_id STRING,generation_id STRING,
 marker_id INT64,order_id INT64,line_id INT64,included BOOL
) PARTITION BY publication_date CLUSTER BY scope_shard,customer_id,generation_id;
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_screening_counter_publications`(
 publication_date DATE,scope_shard INT64,customer_id STRING,contract STRING,
 generation_id STRING,snapshot_id STRING,source_capture_hash STRING,
 source_cdc_through_ms INT64,source_complete BOOL,marker_rows INT64,rows_hash STRING
) PARTITION BY publication_date CLUSTER BY scope_shard,customer_id,generation_id;

-- Publisher receives the AUTHENTICATED native capture metadata, never native
-- marker rows. Its connector barrier must prove the selected cohort complete
-- through source_finished_at_ms. BQ background-apply time/max_staleness is NOT
-- that barrier. Missing barrier or missing marker replication forbids this job.
-- Use a deterministic BigQuery job ID derived from snapshot_id/generation_id;
-- lost submission acknowledgment reconciles that job and exact generation.
-- Dry-run this SELECT under the <=1GB cap BEFORE separately authorized writes.
CREATE TEMP TABLE candidate AS
 SELECT SAFE_CAST(s.id AS INT64) AS marker_id,SAFE_CAST(s.order_id AS INT64) AS order_id,
 SAFE_CAST(s.has_product_id AS INT64) AS line_id,
 COALESCE(SAFE_CAST(hp.prod_id AS INT64)=390238 AND SAFE_CAST(o.order_status AS INT64) NOT IN(0,17),FALSE) AS included
 FROM `tssgcp2025.tss_mysql_raw_layer.tss_spiderman_screening_orders` s
 LEFT JOIN `tssgcp2025.tss_mysql_raw_layer.tss_orders` o ON SAFE_CAST(o.id AS INT64)=SAFE_CAST(s.order_id AS INT64)
 LEFT JOIN `tssgcp2025.tss_mysql_raw_layer.tss_has_products` hp ON SAFE_CAST(hp.id AS INT64)=SAFE_CAST(s.has_product_id AS INT64)
 WHERE SAFE_CAST(s.user_id AS INT64)=SAFE_CAST(@customer_id AS INT64);
ASSERT (SELECT COUNT(*)<=10000 AND COUNT(*)=COUNT(DISTINCT marker_id)
 AND COUNTIF(marker_id IS NULL OR order_id IS NULL OR line_id IS NULL)=0 FROM candidate)
 AS 'Incomplete screening cohort';
ASSERT @source_complete IS TRUE AND @source_cdc_through_ms>=@source_finished_at_ms
 AND @source_cdc_through_ms<=@published_at_ms
 AND @published_at_ms-@source_captured_at_ms<=60000 AS 'Unqualified source barrier';
ASSERT (SELECT COUNT(*)=@source_rows AND COUNTIF(included)=@source_count FROM candidate)
 AS 'Native/warehouse conservation mismatch';
ASSERT (SELECT LOWER(TO_HEX(SHA256(CONCAT('[',COALESCE(STRING_AGG(
 CONCAT('[',TO_JSON_STRING(CAST(marker_id AS STRING)),',',TO_JSON_STRING(CAST(order_id AS STRING)),',',
 TO_JSON_STRING(CAST(line_id AS STRING)),',',IF(included,'true','false'),']'),',' ORDER BY marker_id),''),']'))))=@source_rows_hash FROM candidate)
 AS 'Native/warehouse identity mismatch';
BEGIN TRANSACTION;
ASSERT NOT EXISTS(SELECT 1 FROM `tssgcp2025.tss_mysql_raw_layer.pos_screening_counter_publications`
 WHERE publication_date=DATE(TIMESTAMP_MILLIS(@published_at_ms)) AND scope_shard=@scope_shard
 AND customer_id=@customer_id AND generation_id=@generation_id) AS 'Reconcile existing generation';
INSERT INTO `tssgcp2025.tss_mysql_raw_layer.pos_screening_counter_rows`
 SELECT DATE(TIMESTAMP_MILLIS(@published_at_ms)),@scope_shard,@customer_id,@generation_id,
 marker_id,order_id,line_id,included FROM candidate;
INSERT INTO `tssgcp2025.tss_mysql_raw_layer.pos_screening_counter_publications`
 VALUES(DATE(TIMESTAMP_MILLIS(@published_at_ms)),@scope_shard,@customer_id,
 'pos-screening-counter-bq-candidate-v1',@generation_id,@snapshot_id,@source_capture_hash,
 @source_cdc_through_ms,TRUE,@source_rows,@source_rows_hash);
COMMIT TRANSACTION;
