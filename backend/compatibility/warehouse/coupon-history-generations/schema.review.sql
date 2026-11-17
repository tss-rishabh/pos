-- REVIEW ONLY. Never run by the reader/runtime or with the authorized reader SA.
-- Fixed deployment: project tssgcp2025, dataset tss_mysql_raw_layer, asia-south1.
-- Create only through the separate deployment identity after review. No existing
-- raw source or legacy MySQL table is changed. Publisher uses append-only INSERT.
-- Dataset location, IAM, row-level policies, retention and CDC completeness must
-- be reviewed separately; CREATE does not establish source completeness.
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_generation_orders` (
  scope_shard INT64 NOT NULL, source_day DATE NOT NULL,
  projection_contract STRING NOT NULL, generation_id STRING NOT NULL,
  snapshot_id STRING NOT NULL, head_hash STRING NOT NULL,
  order_id STRING NOT NULL, user_id STRING, coupon_used STRING,
  order_status INT64, created_at DATETIME
)
PARTITION BY source_day CLUSTER BY scope_shard,generation_id,order_id
OPTIONS(require_partition_filter=TRUE,description='Immutable scoped coupon order projection; qualified only by the matching sealed generation');

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_generation_logs` (
  scope_shard INT64 NOT NULL, source_day DATE NOT NULL,
  projection_contract STRING NOT NULL, generation_id STRING NOT NULL,
  snapshot_id STRING NOT NULL, head_hash STRING NOT NULL,
  log_id STRING NOT NULL, user_id STRING, coupon_id STRING,
  status INT64, created_at DATETIME
)
PARTITION BY source_day CLUSTER BY scope_shard,generation_id,log_id
OPTIONS(require_partition_filter=TRUE,description='Bounded source-authenticated publisher-only coupon log export; no application history fallback');

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_generation_controls` (
  scope_shard INT64 NOT NULL, source_day DATE NOT NULL,
  projection_contract STRING NOT NULL, generation_id STRING NOT NULL,
  snapshot_id STRING NOT NULL, head_hash STRING NOT NULL,
  coupon_id STRING NOT NULL, present BOOL NOT NULL, lot_matches BOOL NOT NULL,
  same_code BOOL NOT NULL, no_times_allowed STRING, unique_no_times_allowed STRING
)
PARTITION BY source_day CLUSTER BY scope_shard,generation_id,coupon_id
OPTIONS(require_partition_filter=TRUE,description='Native collation/equality controls authenticated by the exact generation; no raw coupon code or lot');

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_generation_candidates` (
  scope_shard INT64 NOT NULL, contract STRING NOT NULL,
  customer_id STRING NOT NULL, coupon_id STRING NOT NULL,
  configuration_hash STRING NOT NULL, source_day DATE NOT NULL,
  source_time_zone STRING NOT NULL, generation_id STRING NOT NULL,
  snapshot_id STRING NOT NULL, capture_hash STRING NOT NULL,
  head_hash STRING NOT NULL, materialized_at TIMESTAMP NOT NULL,
  capture_document STRING NOT NULL, candidate_complete BOOL NOT NULL
)
PARTITION BY source_day CLUSTER BY scope_shard,customer_id,coupon_id,head_hash
OPTIONS(require_partition_filter=TRUE,description='Complete append-only candidate created in the same transaction as all projection rows; not a usable publication');

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_generation_publications` (
  scope_shard INT64 NOT NULL, contract STRING NOT NULL,
  customer_id STRING NOT NULL, coupon_id STRING NOT NULL,
  configuration_hash STRING NOT NULL, source_day DATE NOT NULL,
  source_time_zone STRING NOT NULL, generation_id STRING NOT NULL,
  snapshot_id STRING NOT NULL, capture_hash STRING NOT NULL,
  head_hash STRING NOT NULL, materialized_at TIMESTAMP NOT NULL,
  capture_document STRING NOT NULL, publication_document STRING NOT NULL,
  published_at TIMESTAMP NOT NULL
)
PARTITION BY source_day CLUSTER BY scope_shard,customer_id,coupon_id,head_hash
OPTIONS(require_partition_filter=TRUE,description='Publication sealed only after independent candidate facts and row commitments match the genuine native snapshot');
