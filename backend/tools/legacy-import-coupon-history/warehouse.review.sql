-- REVIEW ONLY. No application migration or SDK path executes this file.
-- Fixed dataset/location: tssgcp2025.tss_mysql_raw_layer, asia-south1.
-- Dedicated IMMUTABLE projections, never aliases over mutable raw CDC.
-- Selection requires a complete native snapshot/generation publisher and all
-- writer head participation. Per-table CDC timestamps alone are insufficient.

CREATE TABLE tssgcp2025.tss_mysql_raw_layer.pos_coupon_history_orders_v1 (
  scope_shard INT64 NOT NULL, projection_contract STRING NOT NULL,
  generation_id STRING NOT NULL, snapshot_id STRING NOT NULL,
  control_head_hash STRING NOT NULL, order_id STRING NOT NULL,
  user_id STRING, coupon_used STRING, order_status INT64, created_at DATETIME
)
PARTITION BY RANGE_BUCKET(scope_shard, GENERATE_ARRAY(0, 1024, 1))
CLUSTER BY generation_id, control_head_hash;

CREATE TABLE tssgcp2025.tss_mysql_raw_layer.pos_coupon_history_logs_v1 (
  scope_shard INT64 NOT NULL, projection_contract STRING NOT NULL,
  generation_id STRING NOT NULL, snapshot_id STRING NOT NULL,
  control_head_hash STRING NOT NULL, log_id STRING NOT NULL,
  user_id STRING, coupon_id STRING, status INT64, created_at DATETIME
)
PARTITION BY RANGE_BUCKET(scope_shard, GENERATE_ARRAY(0, 1024, 1))
CLUSTER BY generation_id, control_head_hash;

CREATE TABLE tssgcp2025.tss_mysql_raw_layer.pos_coupon_history_controls_v1 (
  scope_shard INT64 NOT NULL, projection_contract STRING NOT NULL,
  generation_id STRING NOT NULL, snapshot_id STRING NOT NULL,
  control_head_hash STRING NOT NULL, coupon_id STRING NOT NULL,
  present BOOL NOT NULL, lot_matches BOOL NOT NULL, same_code BOOL NOT NULL,
  no_times_allowed STRING, unique_no_times_allowed STRING
)
PARTITION BY RANGE_BUCKET(scope_shard, GENERATE_ARRAY(0, 1024, 1))
CLUSTER BY generation_id, control_head_hash;

CREATE TABLE tssgcp2025.tss_mysql_raw_layer.pos_coupon_history_candidates_v1 (
  scope_shard INT64 NOT NULL, contract STRING NOT NULL,
  operation_id STRING NOT NULL, request_hash STRING NOT NULL, plan_hash STRING NOT NULL,
  customer_id STRING NOT NULL, coupon_id STRING NOT NULL, configuration_hash STRING NOT NULL,
  as_of DATETIME NOT NULL, source_time_zone STRING NOT NULL,
  generation_id STRING NOT NULL, snapshot_id STRING NOT NULL,
  source_capture_hash STRING NOT NULL, control_head_hash STRING NOT NULL,
  source_cdc_through TIMESTAMP NOT NULL, source_capture_document STRING NOT NULL,
  control_document STRING NOT NULL, candidate_complete BOOL NOT NULL
)
PARTITION BY RANGE_BUCKET(scope_shard, GENERATE_ARRAY(0, 1024, 1))
CLUSTER BY generation_id, operation_id, control_head_hash;

CREATE TABLE tssgcp2025.tss_mysql_raw_layer.pos_coupon_history_publications_v1 (
  scope_shard INT64 NOT NULL, contract STRING NOT NULL,
  operation_id STRING NOT NULL, request_hash STRING NOT NULL, plan_hash STRING NOT NULL,
  customer_id STRING NOT NULL, coupon_id STRING NOT NULL, configuration_hash STRING NOT NULL,
  as_of DATETIME NOT NULL, source_time_zone STRING NOT NULL,
  generation_id STRING NOT NULL, snapshot_id STRING NOT NULL,
  source_capture_hash STRING NOT NULL, control_head_hash STRING NOT NULL,
  source_cdc_through TIMESTAMP NOT NULL, source_capture_document STRING NOT NULL,
  control_document STRING NOT NULL, publication_document STRING NOT NULL
)
PARTITION BY RANGE_BUCKET(scope_shard, GENERATE_ARRAY(0, 1024, 1))
CLUSTER BY generation_id, operation_id, control_head_hash;

-- Read-only materialization projections. The source-generation relations below
-- are reviewed input names for a COMPLETE snapshot, not deployed views/current
-- raw tables. Every selected source PK appears once. No usage counts imported.
SELECT @shard AS scope_shard,
  'pos-csv-coupon-immutable-projection-v1' AS projection_contract,
  @generation AS generation_id, @snapshot AS snapshot_id, @headHash AS control_head_hash,
  CAST(id AS STRING) AS order_id, CAST(user_id AS STRING) AS user_id,
  CAST(coupon_used AS STRING) AS coupon_used, order_status, created_at
FROM tssgcp2025.tss_mysql_raw_layer.pos_coupon_source_order_generation_review
WHERE source_snapshot_id = @snapshot
  AND (user_id = CAST(@customer AS INT64) OR coupon_used = CAST(@coupon AS INT64));
-- NO date/status filter. Other customers and already-present future rows count.

SELECT @shard AS scope_shard,
  'pos-csv-coupon-immutable-projection-v1' AS projection_contract,
  @generation AS generation_id, @snapshot AS snapshot_id, @headHash AS control_head_hash,
  CAST(id AS STRING) AS log_id, CAST(user_id AS STRING) AS user_id,
  CAST(coupon_id AS STRING) AS coupon_id, status, created_at
FROM tssgcp2025.tss_mysql_raw_layer.pos_coupon_source_log_generation_review
WHERE source_snapshot_id = @snapshot AND user_id = CAST(@customer AS INT64);
-- NO date/status/coupon filter. The source join is user+coupon, not log.order_id.

-- Controls are loaded EXACTLY from qualification-only
-- couponWarehouseSourceControls().capture(signedNativeCapture):
-- complete distinct referenced coupon IDs plus target, including zero/orphans.
-- No raw code/lot transferred. Native collation/PAD SPACE flags and allowances
-- are authenticated by metadata fingerprint and signed row count/hash.
--
-- After all three immutable projections are durable, append ONE candidate with
-- exact signed capture, head/scope/generation/snapshot, and coherent CDC-through
-- >= source finishedAt. candidate_complete=true alone is not an eligibility seal.
-- couponWarehouseCapture independently SELECTs the candidate+primitive rows.
-- sealCouponWarehousePublication compares all five facts to signed native facts
-- and emits a signed review artifact, performing NO warehouse write.
-- Only an explicitly authorized publisher may append ONE publication row.
-- Changed heads require NEW generations, never edits to old immutable rows.
-- Neither the runtime nor the read-only SA can execute these review DDL/writes.
