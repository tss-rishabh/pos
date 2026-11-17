-- REVIEW ONLY. Not registered as an application migration. No live DDL, cloud
-- write, upload or publisher activation is authorized/performed by this slice.
-- All four projections are immutable-generation artifacts in the allowed
-- project/dataset/location. The runtime uses a strictly read-only SA.
-- scope_shard = MOD(CAST(customer_id AS INT64),1024), not order-ID sharding.
-- Each source snapshot must be independently captured/signed, staged, verified
-- against BQ and sealed before one COMPLETE publication is written LAST.

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_csv_membership_orders_v1` (
 scope_shard INT64 NOT NULL,generation_id STRING NOT NULL,customer_id STRING NOT NULL,
 order_id STRING NOT NULL,payment_method INT64 NOT NULL,order_status INT64 NOT NULL,
 created_at DATETIME NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,generation_id;
-- This contains all source-customer order headers, including older delivered
-- ones needed for total existence/latest proof. Do not stage only recent rows.

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_csv_membership_lines_v1` (
 scope_shard INT64 NOT NULL,generation_id STRING NOT NULL,customer_id STRING NOT NULL,
 order_id STRING NOT NULL,line_id STRING NOT NULL,product_id STRING NOT NULL,
 is_exclusive_order INT64 NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,generation_id,order_id;
-- Every selected latest/recent order needs its entire HP set, including member
-- products, zero/mixed flags and empty-set proof. Never filter to a helpful flag.

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_csv_membership_candidates_v1` (
 scope_shard INT64 NOT NULL,contract STRING NOT NULL,generation_id STRING NOT NULL,
 customer_id STRING NOT NULL,as_of DATETIME NOT NULL,cutoff DATETIME NOT NULL,
 source_time_zone STRING NOT NULL,source_snapshot_id STRING NOT NULL,
 source_capture_hash STRING NOT NULL,source_cdc_through TIMESTAMP NOT NULL,
 candidate_complete BOOL NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,generation_id;
-- contract = pos-csv-membership-warehouse-candidate-v1
-- source_capture_hash is the source capture HMAC; no signing key is uploaded.
-- One explicit candidate row is mandatory even for a signed native zero.
-- Candidate completeness alone is never proof; native counts/digest + actual
-- warehouse counts/uniqueness/rows must independently agree in the sealer.

CREATE TABLE IF NOT EXISTS `tssgcp2025.tss_mysql_raw_layer.pos_csv_membership_publications_v1` (
 scope_shard INT64 NOT NULL,contract STRING NOT NULL,generation_id STRING NOT NULL,
 customer_id STRING NOT NULL,as_of DATETIME NOT NULL,cutoff DATETIME NOT NULL,
 source_time_zone STRING NOT NULL,source_snapshot_id STRING NOT NULL,
 source_snapshot_at TIMESTAMP NOT NULL,source_cdc_through TIMESTAMP NOT NULL,
 published_at TIMESTAMP NOT NULL,source_complete BOOL NOT NULL,
 source_order_count INT64 NOT NULL,warehouse_order_count INT64 NOT NULL,
 source_selected_order_count INT64 NOT NULL,warehouse_selected_order_count INT64 NOT NULL,
 source_line_count INT64 NOT NULL,warehouse_line_count INT64 NOT NULL,
 source_history_hash STRING NOT NULL,warehouse_history_hash STRING NOT NULL,
 signature STRING NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,generation_id;
-- contract = pos-csv-membership-publication-v1
-- source_snapshot_at is the source criteria clock at its literal SECOND
-- precision; the native capture separately retains exact capturedAt/finishedAt.
-- Publish only the object returned by sealCsvMembershipHistoryPublication.
-- Never overwrite a generation, copy source digests as claimed warehouse proof,
-- or fabricate completeness from independent raw CDC progress timestamps.
-- Configure the four BQ view options with these qualified tables or genuinely
-- equivalent views. Reader dry-run budgets still apply to the resolved plan.
-- Old generations can be retained separately for audit; retention/load
-- orchestration and actual publication writes require an approved publisher
-- identity and are not performed by the read-only application/reader account.
