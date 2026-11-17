-- REVIEW ONLY; a separately authorized complete-source publisher supplies these
-- customer-sharded, generation-bound projections. Reader credentials never DDL.
-- Replace identifiers explicitly; no runtime inference of a dataset/table alias.
-- The orders source must include deleted/status/customer/id changes through the
-- exact native witness revision. A CDC apply timestamp alone is insufficient.
WITH customer_orders AS (
 SELECT CAST(id AS STRING) AS id,order_status,flag_id
 FROM `PROJECT.DATASET.COMPLETE_ORDERS_GENERATION`
 WHERE scope_shard=@shard AND generation_id=@generation AND user_id=@customer
)
SELECT @customer AS customer_id,@generation AS generation_id,@revision AS head_revision,
 COUNT(*) AS order_rows,COUNT(DISTINCT id) AS unique_orders,
 COUNTIF(order_status!=4) AS welcome_count,
 COUNTIF(order_status=3 AND flag_id=18) AS app_cashback_count,
 COUNTIF(order_status=3 AND flag_id!=18) AS web_cashback_count,
 TO_HEX(SHA256(TO_JSON_STRING(ARRAY_AGG(STRUCT(id,order_status,flag_id) ORDER BY LENGTH(id),id)))) AS rows_hash
FROM customer_orders;
-- Empty cohorts require an explicit independently signed zero-row publication;
-- the publisher canonicalizes ARRAY_AGG NULL to [] in its byte/hash contract.
-- Publication.document is the strict pos-screening-origin-history-publication-v1
-- JSON and signature from the independent publication key, never the source key.
