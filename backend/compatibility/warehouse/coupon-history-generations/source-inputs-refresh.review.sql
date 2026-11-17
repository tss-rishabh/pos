-- REVIEW ONLY: independently refresh the two bounded source-order layouts using
-- a separately authorized warehouse deployment/scheduler identity. Never run
-- with the authorized readonly SA, from a request, or from the runtime reader.
-- Dry-run/approve the full-source read budget separately before scheduling.
-- This script is authored but has not been executed in this implementation.
-- BigQuery statement snapshots and native/candidate proof remain distinct: this
-- is not a claim that raw CDC has caught up with the native source. A lagged,
-- duplicated, partial or divergent snapshot cannot pass the later comparison.
CREATE TEMP TABLE coupon_source_orders_snapshot AS
SELECT id,user_id,coupon_used,order_status,created_at
FROM `tssgcp2025.tss_mysql_raw_layer.tss_orders`;

CREATE OR REPLACE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_source_orders_by_customer`
CLUSTER BY user_id,coupon_used,id AS
SELECT id,user_id,coupon_used,order_status,created_at FROM coupon_source_orders_snapshot;

CREATE OR REPLACE TABLE `tssgcp2025.tss_mysql_raw_layer.pos_coupon_source_orders_by_coupon`
CLUSTER BY coupon_used,user_id,id AS
SELECT id,user_id,coupon_used,order_status,created_at FROM coupon_source_orders_snapshot;

-- Both layouts derive from the same temporary source snapshot. Their replacement
-- is not one atomic permanent-table DDL transaction. Concurrent publication sees
-- either matching independently verified facts or a refusal; no generation is
-- sealed from a watermark, an empty result, or a copied native aggregate.
-- For a continuous CDC layout replace this scheduler only with an independently
-- reviewed equivalent that preserves the exact primitive row set and all future
-- dates. Do not add an event-time upper bound absent from the original source.
