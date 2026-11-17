-- REVIEW ONLY. Execute only with separately accepted warehouse writer authority.
-- The supplied reports-bigquery-reader identity must never apply this artifact.
-- Independent origin-scoped normalized orders/HP views must expose the exact
-- source wall DATETIME, full IDs, method/status and per-HP exclusive flag, plus
-- source_schema/source_server_uuid. Do not alias unrelated raw tables or imply
-- that CDC metadata is a complete generation. The background publisher compares
-- each source-signed snapshot to independently read warehouse primitives first.
CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_public_membership_publications` (
 scope_shard INT64 NOT NULL,
 contract STRING NOT NULL,
 customer_id STRING NOT NULL,
 source_time_zone STRING NOT NULL,
 configuration_hash STRING NOT NULL,
 generation_id STRING NOT NULL,
 as_of DATETIME NOT NULL,
 cutoff DATETIME NOT NULL,
 source_capture JSON NOT NULL,
 publication JSON NOT NULL,
 warehouse_selection JSON NOT NULL,
 published_at TIMESTAMP NOT NULL
) PARTITION BY DATE(as_of) CLUSTER BY customer_id,configuration_hash,generation_id;
