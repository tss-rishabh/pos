-- REVIEW ONLY. Never execute with the supplied read-only service account.
-- A separate publisher must establish an authoritative common source checkpoint,
-- exact normalized bytes/counts and complete CDC before publishing a generation.
-- Names target the already-authorized raw dataset; these objects do NOT exist by
-- implication. Creating them requires separately authorized publisher deployment.
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_public_order_headers_v1` (
 generation_id STRING NOT NULL,order_id STRING NOT NULL,customer_id STRING NOT NULL,
 reference STRING NOT NULL,first_name STRING NOT NULL,last_name STRING NOT NULL,
 amount STRING NOT NULL,status STRING,payment_status STRING,payment_status_id STRING,
 created_at DATETIME NOT NULL
) PARTITION BY DATE(created_at) CLUSTER BY generation_id,order_id,customer_id;

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_public_order_stores_v1` (
 generation_id STRING NOT NULL,business_date DATE NOT NULL,order_store_id STRING NOT NULL,
 order_id STRING NOT NULL,store_id STRING NOT NULL,counter_id STRING NOT NULL
) PARTITION BY business_date CLUSTER BY store_id,generation_id,order_id;

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_public_order_lines_v1` (
 generation_id STRING NOT NULL,business_date DATE NOT NULL,line_id STRING NOT NULL,
 order_id STRING NOT NULL,product_id STRING NOT NULL,name STRING,
 quantity STRING NOT NULL,amount STRING NOT NULL,gst STRING NOT NULL,status STRING NOT NULL
) PARTITION BY business_date CLUSTER BY order_id,generation_id,line_id;

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_public_order_publications_v1` (
 generation_id STRING NOT NULL,contract_version STRING NOT NULL,kind STRING NOT NULL,
 scope_id STRING NOT NULL,scope_shard INT64 NOT NULL,business_date DATE,
 source_complete BOOL NOT NULL,source_snapshot_id STRING NOT NULL,
 source_snapshot_at TIMESTAMP NOT NULL,source_cdc_watermark TIMESTAMP NOT NULL,published_at TIMESTAMP NOT NULL,
 source_rows INT64 NOT NULL,warehouse_rows INT64 NOT NULL,
 source_orders INT64 NOT NULL,warehouse_orders INT64 NOT NULL,
 source_stores INT64 NOT NULL,warehouse_stores INT64 NOT NULL,
 source_lines INT64 NOT NULL,warehouse_lines INT64 NOT NULL,
 source_hash STRING NOT NULL,warehouse_hash STRING NOT NULL,
 source_copy_hash STRING,warehouse_copy_hash STRING
) PARTITION BY RANGE_BUCKET(scope_shard,GENERATE_ARRAY(0,1024,1))
  CLUSTER BY kind,scope_id,generation_id;

-- Publisher invariants:
-- * Every ID is a canonical decimal STRING; never decode through float/JS Number.
-- * scope_shard = MOD(scope_id,1024), calculated as an exact integer.
-- * One header per (generation,order_id), one association per physical OrderStore
--   PK, one line per physical HasProduct PK. Duplicate SKU and store associations
--   remain; no DISTINCT order/SKU reducer or quantity expansion is permitted.
-- * Both child business_date columns derive from Order.created_at, NOT the child
--   created/updated date. Lines use prod_id, never a sub_prod_id substitution.
-- * Product name uses LEFT JOIN products ON products.id=has_products.prod_id;
--   unavailable/deleted/missing catalog rows must not remove HasProduct rows.
-- * Monetary/float strings are String(native MySQL driver number), including
--   scientific notation and float32 decoding. BQ CAST(FLOAT64 AS STRING) is NOT
--   assumed equivalent. Publish from the verified native normalization encoder.
-- * Native created_at is source DATETIME(0); preserve its wall clock, do not
--   reinterpret it as UTC or substitute application/CDC ingestion timestamps.
-- * Store-day manifests exist for every covered day INCLUDING empty days, have
--   source_rows=source_stores, source_orders=distinct orders, source_lines=0,
--   and NULL copy hashes. One range generation uses identical immutable snapshot
--   identity/timestamps and one publication timestamp for all its date manifests.
-- * Order manifests use scope_id=order_id, source_rows=orders+stores+lines, and
--   both full and minimal-copy hashes. The business_date anchors the second,
--   statically partitioned point query. Every manifest/normalized row is immutable
--   within its generation and retained for the 15-minute cursor lifetime.
-- * Independently source-compute and warehouse-compute ALL counts/hashes before
--   setting source_complete=true. Never copy warehouse values into source_*.
-- * Hash format and exact field order are executable in modules/order-history/
--   hashes.ts, with native/GCP generated-fixture differential tests. No GROUP_CONCAT
--   cap, ambiguous order, XOR hash, NULL concatenation or float ID is allowed.
-- * Complete raw Datastream/CDC metadata alone does not establish this independent
--   multi-table publication contract. Do not alias raw tables to these names.
