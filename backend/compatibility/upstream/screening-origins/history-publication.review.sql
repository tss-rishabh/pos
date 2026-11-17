-- REVIEW / SEPARATE WRITER ONLY. Never run with the supplied readonly SA.
-- No raw CDC max timestamp or copied native scalar counts assert completeness.
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_origin_history_orders_v1` (
 scope_shard INT64 NOT NULL,generation_id STRING NOT NULL,customer_id STRING NOT NULL,
 order_id STRING NOT NULL,status STRING,flag STRING
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,generation_id,order_id OPTIONS(require_partition_filter=true);
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_origin_history_manifests_v1` (
 scope_shard INT64 NOT NULL,generation_id STRING NOT NULL,customer_id STRING NOT NULL,document STRING NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,generation_id OPTIONS(require_partition_filter=true);
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_origin_history_counts_v1` (
 scope_shard INT64 NOT NULL,generation_id STRING NOT NULL,customer_id STRING NOT NULL,
 head_revision STRING NOT NULL,source_schema STRING NOT NULL,source_server_uuid STRING NOT NULL,writers_hash STRING NOT NULL,
 order_rows INT64 NOT NULL,unique_orders INT64 NOT NULL,welcome_count INT64 NOT NULL,
 app_cashback_count INT64 NOT NULL,web_cashback_count INT64 NOT NULL,rows_hash STRING NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,head_revision,generation_id OPTIONS(require_partition_filter=true);
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_origin_history_publications_v1` (
 scope_shard INT64 NOT NULL,generation_id STRING NOT NULL,customer_id STRING NOT NULL,
 head_revision STRING NOT NULL,source_schema STRING NOT NULL,source_server_uuid STRING NOT NULL,writers_hash STRING NOT NULL,document STRING NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
CLUSTER BY customer_id,head_revision,generation_id OPTIONS(require_partition_filter=true);

-- Independent literal reducer. Strings are canonical signed native integer
-- projections, not arbitrary text/collation aliases. No event-time upper bound.
-- ARRAY(subquery) is explicitly [] for an empty independently captured cohort.
WITH scoped AS (
 SELECT order_id AS id,status,flag
 FROM `tssgcp2025.tss_mysql_raw_layer.pos_origin_history_orders_v1`
 WHERE scope_shard=@shard AND generation_id=@generation AND customer_id=@customer
)
SELECT COUNT(*) AS order_rows,COUNT(DISTINCT id) AS unique_orders,
 COUNTIF(status IS NOT NULL AND status!='4') AS welcome_count,
 COUNTIF(status='3' AND flag='18') AS app_cashback_count,
 COUNTIF(status='3' AND flag IS NOT NULL AND flag!='18') AS web_cashback_count,
 LOWER(TO_HEX(SHA256(TO_JSON_STRING(ARRAY(
  SELECT AS STRUCT flag,id,status FROM scoped ORDER BY LENGTH(id),id
 ))))) AS rows_hash FROM scoped;
-- The actual generated scripts are in history-generation-warehouse.ts.
-- Materialization atomically inserts the real readonly source snapshot rows
-- and signed manifest. Candidate SELECT independently reduces those BQ rows.
-- Publication compares counts+ordered-set hash, then atomically inserts the
-- actual SELECT-derived counts and signed native/BQ-qualified publication.
-- Each script has one retained original job ID and exact query/typed-parameter
-- verification. Any lost response is GET-only; no retry/new generation nonce.
