-- REVIEW ARTIFACT ONLY. This file is never executed by the application.
-- A deployment-owned publisher creates/maintains these private, SELECT-only API
-- views in the configured BigQuery dataset. The application has read permission
-- only. Replace the dataset names via deployment review, not request input.
-- No customer credentials, raw provider payloads or tokens enter details_json.
-- Project every complete object with onlineDetailFact and preserve its exact JSON
-- bytes; SHA256/details_hash attest those bytes. Publish fact+manifest under one
-- generation/checkpoint only after all source rows are copied and counted.
-- A source snapshot includes the entire order, every product line, associated
-- operational ownership/Express IDs and every transaction event. Profile/wallet
-- and Product names/parent IDs are current dimensions and do not belong in
-- this historical JSON. HP price/GST remain historical order facts.

CREATE TABLE `PROJECT.DATASET.pos_online_order_detail_facts_v1` (
  contract_version STRING NOT NULL,
  generation_id STRING NOT NULL,
  order_id STRING NOT NULL,
  order_shard INT64 NOT NULL, -- MOD(CAST(order_id AS BIGNUMERIC), 8192)
  business_date DATE NOT NULL,
  details_json STRING NOT NULL,
  details_hash STRING NOT NULL
)
PARTITION BY business_date
CLUSTER BY order_shard, order_id, generation_id;

CREATE TABLE `PROJECT.DATASET.pos_online_order_detail_publications_v1` (
  contract_version STRING NOT NULL, -- pos-source-online-order-detail-v1
  generation_id STRING NOT NULL,
  order_id STRING NOT NULL,
  order_shard INT64 NOT NULL,
  customer_id STRING NOT NULL,
  business_date DATE NOT NULL,
  business_timezone STRING NOT NULL,
  source_complete BOOL NOT NULL,
  source_snapshot_id STRING NOT NULL,
  source_snapshot_at TIMESTAMP NOT NULL,
  source_cdc_watermark TIMESTAMP NOT NULL,
  published_at TIMESTAMP NOT NULL,
  source_rows INT64 NOT NULL, -- exactly one complete fact
  warehouse_rows INT64 NOT NULL,
  source_lines INT64 NOT NULL,
  warehouse_lines INT64 NOT NULL,
  source_events INT64 NOT NULL,
  warehouse_events INT64 NOT NULL,
  source_express INT64 NOT NULL,
  warehouse_express INT64 NOT NULL,
  source_hash STRING NOT NULL,
  warehouse_hash STRING NOT NULL
)
CLUSTER BY order_shard, order_id, published_at;

-- Expose only reviewed columns through the configured *_VIEW names. Marking an
-- incomplete or partial fact as source_complete is forbidden. The reader checks
-- latest generation uniqueness, customer/date binding, source/warehouse counts,
-- byte hash, checkpoint ordering and configured freshness before returning data.
