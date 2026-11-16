import type { OrderHistoryOptions } from './options.js';
import { qualifiedOrderViews } from './options.js';
export interface OrderHistoryStatement {
  statement: string;
  params: Record<string, unknown>;
  types: Record<string, string | string[]>;
}
const header = (
  a: string,
) => `${a}.order_id AS id,${a}.customer_id AS customerId,${a}.reference,${a}.first_name AS first,${a}.last_name AS last,
  ${a}.amount,${a}.status,${a}.payment_status AS paymentStatus,${a}.payment_status_id AS paymentStatusId,
  FORMAT_DATETIME('%Y-%m-%d %H:%M:%S',${a}.created_at) AS createdAt`;
const store = (a: string) =>
  `${a}.order_store_id AS id,${a}.order_id AS orderId,${a}.store_id AS storeId,${a}.counter_id AS counterId`;
const line = (a: string) =>
  `${a}.line_id AS id,${a}.order_id AS orderId,${a}.product_id AS productId,${a}.name,${a}.quantity,${a}.amount,${a}.gst,${a}.status`;
const encode = (field: string) =>
  `IF(${field} IS NULL,'-',CONCAT('+',LOWER(TO_HEX(CAST(${field} AS BYTES)))))`;
const rowHash = (fields: string[]) =>
  `LOWER(TO_HEX(SHA256(CONCAT(${fields.map(encode).join(", '|', ")}))))`;
const manifest = `generation_id,contract_version,kind,scope_id,FORMAT_DATE('%F',business_date) AS business_date,source_complete,
  source_snapshot_id,FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_snapshot_at,'UTC') AS source_snapshot_at,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_cdc_watermark,'UTC') AS source_cdc_watermark,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',published_at,'UTC') AS published_at,
  CAST(source_rows AS STRING) AS source_rows,CAST(warehouse_rows AS STRING) AS warehouse_rows,
  CAST(source_orders AS STRING) AS source_orders,CAST(warehouse_orders AS STRING) AS warehouse_orders,
  CAST(source_stores AS STRING) AS source_stores,CAST(warehouse_stores AS STRING) AS warehouse_stores,
  CAST(source_lines AS STRING) AS source_lines,CAST(warehouse_lines AS STRING) AS warehouse_lines,
  source_hash,warehouse_hash,source_copy_hash,warehouse_copy_hash`;
export function historyListSql(options: OrderHistoryOptions) {
  const v = qualifiedOrderViews(options);
  const fields = [
    "'list'",
    "'header'",
    'h.order_id',
    'h.customer_id',
    'h.reference',
    'h.first_name',
    'h.last_name',
    'h.amount',
    'h.status',
    'h.payment_status',
    'h.payment_status_id',
    "FORMAT_DATETIME('%Y-%m-%d %H:%M:%S',h.created_at)",
    "'store'",
    's.order_store_id',
    's.order_id',
    's.store_id',
    's.counter_id',
  ];
  return `WITH candidates AS (
    SELECT * FROM \`${v.publications}\` WHERE contract_version=@contract AND kind='store-day' AND scope_id=@store AND scope_shard=@shard
      AND business_date BETWEEN @from AND @to AND (@generation='' OR generation_id=@generation)
  ), latest AS (SELECT * FROM candidates QUALIFY DENSE_RANK() OVER(ORDER BY published_at DESC)=1),
  row_data AS (
    SELECT DATE(h.created_at) AS business_date,STRUCT(${header('h')}) AS header,STRUCT(${store('s')}) AS store,
      ${rowHash(fields)} AS row_hash
    FROM \`${v.stores}\` s JOIN \`${v.headers}\` h ON h.generation_id=s.generation_id AND h.order_id=s.order_id
    WHERE s.generation_id IN(SELECT generation_id FROM latest) AND s.store_id=@store
      AND s.business_date BETWEEN @from AND @to AND DATE(h.created_at) BETWEEN @from AND @to
      AND h.created_at>=@start AND h.created_at<@end
  ), ordered AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY business_date ORDER BY CAST(header.id AS BIGNUMERIC) DESC,CAST(store.id AS BIGNUMERIC) DESC) AS position FROM row_data),
  chunks AS (SELECT business_date,DIV(position-1,100) AS chunk,LOWER(TO_HEX(SHA256(STRING_AGG(row_hash,'\\n' ORDER BY position)))) AS chunk_hash
    FROM ordered GROUP BY business_date,chunk),
  hashes AS (SELECT business_date,LOWER(TO_HEX(SHA256(STRING_AGG(chunk_hash,'\\n' ORDER BY chunk)))) AS actual_hash FROM chunks GROUP BY business_date),
  counts AS (SELECT business_date,COUNT(*) AS row_count,COUNT(DISTINCT header.id) AS orders,COUNT(DISTINCT store.id) AS unique_stores FROM row_data GROUP BY business_date)
  SELECT ARRAY(SELECT AS STRUCT ${manifest} FROM latest ORDER BY business_date LIMIT 125) AS publications,
    ARRAY(SELECT AS STRUCT FORMAT_DATE('%F',c.business_date) AS business_date,CAST(c.row_count AS STRING) AS \`rows\`,
      CAST(c.orders AS STRING) AS orders,CAST(c.unique_stores AS STRING) AS unique_stores,h.actual_hash
      FROM counts c JOIN hashes h USING(business_date)) AS actual,
    ARRAY(SELECT AS STRUCT header,store FROM row_data
      WHERE @beforeOrder='' OR CAST(header.id AS BIGNUMERIC)<CAST(NULLIF(@beforeOrder,'') AS BIGNUMERIC)
        OR (header.id=@beforeOrder AND CAST(store.id AS BIGNUMERIC)<CAST(NULLIF(@beforeRow,'') AS BIGNUMERIC))
      ORDER BY CAST(header.id AS BIGNUMERIC) DESC,CAST(store.id AS BIGNUMERIC) DESC LIMIT @take) AS page`;
}
export function historyOrderSql(options: OrderHistoryOptions) {
  const v = qualifiedOrderViews(options);
  return `WITH latest AS (SELECT * FROM \`${v.publications}\` WHERE contract_version=@contract AND kind='order' AND scope_id=@order
    AND scope_shard=@shard AND generation_id=@pointGeneration AND business_date=@businessDate AND source_snapshot_id=@snapshot),
  h AS(SELECT * FROM \`${v.headers}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND order_id=@order AND DATE(created_at)=@businessDate),
  s AS(SELECT * FROM \`${v.stores}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND order_id=@order AND business_date=@businessDate),
  l AS(SELECT * FROM \`${v.lines}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND order_id=@order AND business_date=@businessDate)
  SELECT ARRAY(SELECT AS STRUCT ${manifest} FROM latest LIMIT 2) AS publications,
    STRUCT(CAST((SELECT COUNT(*) FROM h) AS STRING) AS headers,CAST((SELECT COUNT(*) FROM s) AS STRING) AS stores,
      CAST((SELECT COUNT(*) FROM l) AS STRING) AS lines,CAST((SELECT COUNT(DISTINCT order_store_id) FROM s) AS STRING) AS unique_stores,
      CAST((SELECT COUNT(DISTINCT line_id) FROM l) AS STRING) AS unique_lines) AS actual,
    ARRAY(SELECT AS STRUCT ${header('h')} FROM h LIMIT 2) AS headers,
    ARRAY(SELECT AS STRUCT ${store('s')} FROM s ORDER BY CAST(order_store_id AS BIGNUMERIC) LIMIT @take) AS stores,
    ARRAY(SELECT AS STRUCT ${line('l')} FROM l ORDER BY CAST(line_id AS BIGNUMERIC) LIMIT @take) AS lines`;
}
/** Minimal source projection: no names, prices, quantity, benefits or Product join. */
export function historyCopySql(options: OrderHistoryOptions) {
  const v = qualifiedOrderViews(options);
  return `WITH latest AS (SELECT * FROM \`${v.publications}\` WHERE contract_version=@contract AND kind='order' AND scope_id=@order
    AND scope_shard=@shard AND generation_id=@pointGeneration AND business_date=@businessDate AND source_snapshot_id=@snapshot),
  h AS(SELECT order_id,customer_id,created_at FROM \`${v.headers}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND order_id=@order AND DATE(created_at)=@businessDate),
  s AS(SELECT order_store_id,order_id,store_id,counter_id FROM \`${v.stores}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND order_id=@order AND business_date=@businessDate),
  l AS(SELECT line_id,order_id,product_id FROM \`${v.lines}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND order_id=@order AND business_date=@businessDate)
  SELECT ARRAY(SELECT AS STRUCT ${manifest} FROM latest LIMIT 2) AS publications,
    STRUCT(CAST((SELECT COUNT(*) FROM h) AS STRING) AS headers,CAST((SELECT COUNT(*) FROM s) AS STRING) AS stores,
      CAST((SELECT COUNT(*) FROM l) AS STRING) AS lines,CAST((SELECT COUNT(DISTINCT order_store_id) FROM s) AS STRING) AS unique_stores,
      CAST((SELECT COUNT(DISTINCT line_id) FROM l) AS STRING) AS unique_lines) AS actual,
    ARRAY(SELECT AS STRUCT order_id AS id,customer_id AS customerId,FORMAT_DATETIME('%Y-%m-%d %H:%M:%S',created_at) AS createdAt FROM h LIMIT 2) AS headers,
    ARRAY(SELECT AS STRUCT ${store('s')} FROM s ORDER BY CAST(order_store_id AS BIGNUMERIC) LIMIT @take) AS stores,
    ARRAY(SELECT AS STRUCT line_id AS id,order_id AS orderId,product_id AS productId FROM l ORDER BY CAST(line_id AS BIGNUMERIC) LIMIT @take) AS lines`;
}
export function historyPointPublicationSql(options: OrderHistoryOptions) {
  const v = qualifiedOrderViews(options);
  return `WITH /* order-history-publication */ latest AS (SELECT * FROM \`${v.publications}\`
    WHERE contract_version=@contract AND kind='order' AND scope_id=@order AND scope_shard=@shard
    QUALIFY DENSE_RANK() OVER(ORDER BY published_at DESC)=1)
    SELECT ARRAY(SELECT AS STRUCT ${manifest} FROM latest LIMIT 2) AS publications`;
}
