-- REVIEW ONLY. The authorized reader is strictly read-only. Do not execute this file with it.
-- A separate approved publisher must capture source-complete common generations, including
-- current customer/store/counter/payment/status/provider dimensions and all physical OS/HP/ELI rows.
CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_order_search_publications_v1` (
  contract_version STRING NOT NULL, generation_id STRING NOT NULL,
  scope_key STRING NOT NULL, scope_shard INT64 NOT NULL, business_date DATE NOT NULL,
  source_complete BOOL NOT NULL, source_snapshot_id STRING NOT NULL,
  source_snapshot_at TIMESTAMP NOT NULL, source_cdc_watermark TIMESTAMP NOT NULL,
  published_at TIMESTAMP NOT NULL, contact_key_id STRING NOT NULL,
  source_rows INT64 NOT NULL, warehouse_rows INT64 NOT NULL,
  source_hash STRING NOT NULL, warehouse_hash STRING NOT NULL
) PARTITION BY RANGE_BUCKET(scope_shard, GENERATE_ARRAY(0,1024,1))
CLUSTER BY scope_key,business_date,generation_id
OPTIONS(require_partition_filter=TRUE);

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_order_search_index_v1` (
  contract_version STRING NOT NULL, generation_id STRING NOT NULL, scope_key STRING NOT NULL,
  business_date DATE NOT NULL, order_id STRING NOT NULL,
  index_json STRING NOT NULL, index_hash STRING NOT NULL
) PARTITION BY business_date CLUSTER BY scope_key,generation_id,order_id
OPTIONS(require_partition_filter=TRUE);

CREATE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_order_search_facts_v1` (
  contract_version STRING NOT NULL, generation_id STRING NOT NULL,
  business_date DATE NOT NULL, order_shard INT64 NOT NULL, order_id STRING NOT NULL,
  fact_json STRING NOT NULL, fact_hash STRING NOT NULL
) PARTITION BY RANGE_BUCKET(order_shard, GENERATE_ARRAY(0,8192,1))
CLUSTER BY generation_id,business_date,order_id
OPTIONS(require_partition_filter=TRUE);

-- scope_key: store:<positive store ID>, global:0, or order:<positive order ID>.
-- scope_shard: decimal scope ID MOD1024 (global=0). Each store-day/global-day,
-- including zero rows, requires a manifest. Point manifests require zero/one row
-- and the actual order business_date (absence tombstones must also be qualified).
-- Store indexes include the UNION of OS.store_id, ELI.store_id, SW.location_id,
-- and verified NW hyperlocal_locations.store_id associations. Never infer NW IDs.
-- global:0 contains every source order; the server still applies ST/HL/HE/N semantics.
-- Point index copies use order:<id>. Duplicate copies across scopes must be identical.
-- Native SourceOrder is validated by sourceFactSchema/ assertFact; preserve full-width
-- IDs, exact native floats, source decimal strings, every OS row, ELI store membership,
-- first-provider precedence, BINARY HP status predicate, and native collation sort weights.
-- fact_json is exact UTF8 JSON; fact_hash=lower HEX SHA256(fact_json).
-- index_json is sourceIndex(fact,fact_hash), exact UTF8 JSON. index_hash=SHA256(index_json).
-- Per-scope/day digest: order rows numerically by ID; row digest SHA256(id || LF || index_hash).
-- historyRowsHash then uses ordered100-row LF chunks and a final LF chunk hash.
-- Empty streams hash the empty string. Source digest/count must be independently
-- captured and conserved by warehouse digest/count, not copied from warehouse output.
-- Publish generation atomically/immutably, retain it until all reads expire, and never
-- reuse generation IDs. CDC background apply time alone is NOT source completeness.

-- Contacts never appear in index/fact JSON. Publisher uses the configured private key:
-- HMAC_SHA256(key, 'pos-order-search-contact-v1' || NUL || purpose || NUL || lowercase_weights).
-- purposes: order-phone / user-phone / email; key ID must match the active reader.
-- Exact physical comparisons:
-- order-phone: HEX(WEIGHT_STRING(orders.phone_no AS CHAR(32))) latin1_swedish_ci
-- user-phone:  HEX(WEIGHT_STRING(users.telephone AS CHAR(32))) utf8mb3_general_ci
-- email:       HEX(WEIGHT_STRING(users.email AS CHAR(96))) utf8mb3_general_ci
-- Sort weights use users.firstname AS CHAR(32), method.name/payment_status AS CHAR(255)
-- in each actual verified column collation. Preserve NULL separately from empty strings.
-- Do not substitute LOWER(), BigQuery Unicode folding, utf8mb4 defaults, or a public hash.
