-- REVIEW ONLY. Provision via separately approved warehouse deployment.
-- The supplied reports-bigquery-reader service account remains SELECT-only.
-- Runtime performs no DDL and never uses ambient/default credentials.
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_screening_counter_rows` (
 publication_date DATE,scope_shard INT64,customer_id STRING,generation_id STRING,
 marker_id INT64,order_id INT64,line_id INT64,included BOOL
) PARTITION BY publication_date CLUSTER BY scope_shard,customer_id,generation_id;
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_screening_counter_publications` (
 publication_date DATE,scope_shard INT64,customer_id STRING,contract STRING,
 generation_id STRING,snapshot_id STRING,source_capture_hash STRING,
 source_cdc_through_ms INT64,source_complete BOOL,marker_rows INT64,rows_hash STRING
) PARTITION BY publication_date CLUSTER BY scope_shard,customer_id,generation_id;
-- Grant the independent publisher INSERT+SELECT on these two tables and job
-- creation in asia-south1. Grant its separate verifier SELECT+job creation only.
-- The source-RO capture exports the exact bounded snapshot rows through the
-- encrypted rewrite journal. source_cdc_through_ms binds that snapshot's finish,
-- not a claim that a raw connector or any wider historical dataset is current.
