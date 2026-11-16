-- REVIEW ONLY. No DDL, publisher, snapshot creation or external writes are executed here.
-- Replace the two identifier placeholders only with trusted immutable snapshots
-- captured at the SAME verified source checkpoint. Raw independently advancing
-- CDC tables do not satisfy that condition.
-- ORDERS_SNAPSHOT must preserve original created_at as created_at_wall STRING;
-- this includes the exact all-zero sentinel that BigQuery DATETIME cannot store.
-- All other invalid dates fail CAST and must be reconciled before publication.
SELECT
  @generation_id AS generation_id,
  CAST(os.id AS STRING) AS order_store_id,
  CAST(os.store_id AS STRING) AS store_id,
  CAST(o.id AS STRING) AS order_id,
  o.order_status,
  CASE
    WHEN o.created_at_wall = '0000-00-00 00:00:00' THEN CAST(NULL AS DATETIME)
    ELSE CAST(o.created_at_wall AS DATETIME)
  END AS order_created_at,
  o.created_at_wall AS source_created_at_wall
FROM `{{ORDER_STORES_SNAPSHOT}}` AS os
INNER JOIN `{{ORDERS_SNAPSHOT}}` AS o ON o.id = os.order_id;

-- Keep every joined association, including status0, for count/digest acceptance.
-- The reader subsequently applies order_status<>0 and monthly wall-date bounds.
-- Separate order_store PKs referring to the same order must NEVER be deduplicated.
