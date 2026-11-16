-- REVIEW ONLY: never executed by the application or read-only fixture tool.
-- A separately authorized publisher creates/populates immutable generations.
-- These prefixed resources have NOT been observed/deployed in the raw dataset.
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_order_import_jobs_v1` (
 generation_id STRING NOT NULL,job_id STRING NOT NULL,job_sequence STRING NOT NULL,
 actor_id STRING NOT NULL,request_hash STRING NOT NULL,kind STRING NOT NULL,state STRING NOT NULL,
 total_orders INT64 NOT NULL,imported_orders INT64 NOT NULL,failed_orders INT64 NOT NULL,cancelled_orders INT64 NOT NULL,
 error_code STRING,created_at TIMESTAMP NOT NULL,updated_at TIMESTAMP NOT NULL,completed_at TIMESTAMP NOT NULL
) CLUSTER BY job_id,generation_id,actor_id;

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_order_import_results_v1` (
 generation_id STRING NOT NULL,job_id STRING NOT NULL,actor_id STRING NOT NULL,request_hash STRING NOT NULL,
 job_created_at TIMESTAMP NOT NULL,job_updated_at TIMESTAMP NOT NULL,
 sequence INT64 NOT NULL,first_row INT64 NOT NULL,operation_id STRING NOT NULL,
 store_id STRING NOT NULL,counter_id STRING NOT NULL,state STRING NOT NULL,
 order_id STRING,receipt_id STRING,business_date STRING,error_code STRING,updated_at TIMESTAMP NOT NULL
) CLUSTER BY job_id,generation_id,sequence;

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_order_import_publications_v1` (
 generation_id STRING NOT NULL,contract_version STRING NOT NULL,job_id STRING NOT NULL,
 actor_id STRING NOT NULL,request_hash STRING NOT NULL,source_complete BOOL NOT NULL,
 source_snapshot_id STRING NOT NULL,source_snapshot_at TIMESTAMP NOT NULL,
 source_cdc_watermark TIMESTAMP NOT NULL,published_at TIMESTAMP NOT NULL,
 source_rows INT64 NOT NULL,warehouse_rows INT64 NOT NULL,
 source_job_hash STRING NOT NULL,warehouse_job_hash STRING NOT NULL,
 source_result_hash STRING NOT NULL,warehouse_result_hash STRING NOT NULL
) CLUSTER BY job_id,contract_version;
-- Publish exactly one generation per completed immutable job, manifest LAST.
-- Independent source/warehouse hashes and counts must match before asserting
-- completeness. A CDC background apply time alone is not source completeness.
-- No encrypted payload, CSV/reference, contacts, names, messages, claim token,
-- request ID or native financial proofHash is part of this publication.
