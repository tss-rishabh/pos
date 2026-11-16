import { z } from 'zod';

const relation = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  );
export const historyTablesSchema = z
  .object({
    orders: relation,
    orderStores: relation,
    lines: relation,
    products: relation,
    feedback: relation,
  })
  .strict();
export type HistoryTables = z.infer<typeof historyTablesSchema>;
export type HistoryLayout = 'raw' | 'customer-bucket-v1';
export const observedHistoryTables: HistoryTables = {
  orders: 'tssgcp2025.tss_mysql_raw_layer.tss_orders',
  orderStores: 'tssgcp2025.tss_mysql_raw_layer.tss_order_stores',
  lines: 'tssgcp2025.tss_mysql_raw_layer.tss_has_products',
  products: 'tssgcp2025.tss_mysql_raw_layer.tss_products',
  feedback: 'tssgcp2025.tss_mysql_raw_layer.tss_nps_feedback',
};
export const initialReturnedItems = 20;
/** One capture group and ASCII whitespace/digits reproduce the source string→number prefix. */
export const mysqlNumericPrefix = String.raw`^[\x09-\x0d\x20]*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)`;
export function mysqlRoundApproximateZero(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(value)) throw new Error('INVALID_STATIC_ROUND_EXPRESSION');
  return `CASE WHEN ABS(${value})-FLOOR(ABS(${value}))=0.5 THEN SIGN(${value})*(FLOOR(ABS(${value}))+MOD(CAST(FLOOR(ABS(${value})) AS INT64),2)) ELSE ROUND(${value},0) END`;
}
/** No request text enters identifiers. All values/cursors/limits are named binds. */
export function customerHistorySql(
  input: HistoryTables = observedHistoryTables,
  layout: HistoryLayout = 'raw',
) {
  const t = historyTablesSchema.parse(input),
    table = (key: keyof HistoryTables) => '`' + t[key] + '`';
  const bucket = (alias: string) =>
    layout === 'customer-bucket-v1'
      ? `${alias}.customer_bucket=MOD(CAST(@customer AS INT64),1024)`
      : 'TRUE';
  return `WITH customer_orders AS (
    SELECT id,order_amt,created_at,order_status FROM ${table('orders')} o WHERE user_id=CAST(@customer AS INT64) AND ${bucket('o')}
  ), store_counts AS (
    SELECT os.order_id,COUNT(os.id) AS store_rows FROM ${table('orderStores')} os INNER JOIN customer_orders o ON o.id=os.order_id WHERE ${bucket('os')} GROUP BY os.order_id
  ), totals AS (
    SELECT COALESCE(SUM(IF(o.order_status NOT IN (0,17),GREATEST(COALESCE(s.store_rows,0),1),0)),0) AS total_orders,
      COALESCE(SUM(IF(o.order_status NOT IN (0,17),COALESCE(s.store_rows,0),0)),0) AS store_orders,
      COUNTIF(o.order_status NOT IN (0,17) AND o.created_at>DATETIME_SUB(@sourceNow,INTERVAL 30 DAY)) AS last_orders,
      COUNTIF(o.order_status=4) AS cancelled_orders,COUNTIF(o.order_status=6) AS returned_orders
    FROM customer_orders o LEFT JOIN store_counts s ON s.order_id=o.id
  ), savings_sum AS (
    SELECT COALESCE(SUM((pap.price*hp.qty)-hp.price),0) AS amount
    FROM customer_orders o LEFT JOIN ${table('lines')} hp ON hp.order_id=o.id AND ${bucket('hp')}
    LEFT JOIN ${table('products')} p ON p.id=IF(hp.sub_prod_id>0,hp.sub_prod_id,hp.prod_id)
    LEFT JOIN ${table('products')} pap ON pap.id=IF(p.parent_prod_id>0,p.parent_prod_id,p.id)
    WHERE o.order_status NOT IN (0,4,7,10,17,22)
  ), numeric_feedback AS (
    SELECT nf.feedback_answer IS NULL AS is_null,REGEXP_EXTRACT(nf.feedback_answer,r'${mysqlNumericPrefix}') AS numeric_prefix
    FROM ${table('feedback')} nf INNER JOIN customer_orders o ON o.id=nf.order_id WHERE ${bucket('nf')}
  ), nps AS (SELECT SAFE_DIVIDE(SUM(IF(is_null,NULL,IF(numeric_prefix IS NULL,0,CAST(numeric_prefix AS FLOAT64)))),CAST(COUNTIF(NOT is_null) AS FLOAT64)) AS score FROM numeric_feedback),
  returned_page AS (
    SELECT o.*,COALESCE(s.store_rows,0)>0 AS is_store FROM customer_orders o LEFT JOIN store_counts s ON s.order_id=o.id
    WHERE o.order_status=6 AND (@returnBefore='' OR o.id<CAST(NULLIF(@returnBefore,'') AS INT64)) ORDER BY o.id DESC LIMIT @pageSize
  ), returned_items AS (
    SELECT hp.order_id,COUNT(*) AS item_count,ARRAY_AGG(p.product ORDER BY hp.id DESC LIMIT ${initialReturnedItems}) AS item_names
    FROM returned_page o INNER JOIN ${table('lines')} hp ON hp.order_id=o.id AND ${bucket('hp')} INNER JOIN ${table('products')} p ON p.id=hp.prod_id GROUP BY hp.order_id
  )
  SELECT STRUCT(${mysqlRoundApproximateZero('s.amount')} AS exclusiveSavings,
    CAST(t.total_orders AS STRING) AS totalOrders,CAST(t.store_orders AS STRING) AS totalStoreOrders,
    CAST(t.total_orders-t.store_orders AS STRING) AS totalOnlineOrders,CAST(t.last_orders AS STRING) AS last30DaysOrders,
    CAST(t.cancelled_orders AS STRING) AS cancelledOrders,CAST(t.returned_orders AS STRING) AS returnedOrders,n.score AS npsScore) AS summary,
    ARRAY(SELECT AS STRUCT CAST(o.id AS STRING) AS id,o.order_amt AS orderAmount,FORMAT_DATE('%F',DATE(o.created_at)) AS createdDate,
      o.order_status AS status,COALESCE(sc.store_rows,0)>0 AS isStoreOrder FROM customer_orders o LEFT JOIN store_counts sc ON sc.order_id=o.id
      ORDER BY DATE(o.created_at) DESC NULLS LAST,o.id DESC LIMIT 5) AS recentOrders,
    ARRAY(SELECT AS STRUCT CAST(o.id AS STRING) AS id,o.order_amt AS orderAmount,COALESCE(i.item_names,ARRAY<STRING>[]) AS itemNames,
      CAST(COALESCE(i.item_count,0) AS STRING) AS itemCount,COALESCE(i.item_count,0)>${initialReturnedItems} AS hasMoreItems,o.is_store AS isStoreOrder
      FROM returned_page o LEFT JOIN returned_items i ON i.order_id=o.id ORDER BY o.id DESC) AS returnedRows
  FROM totals t CROSS JOIN savings_sum s CROSS JOIN nps n`;
}
export function customerHistoryLinesSql(
  input: HistoryTables = observedHistoryTables,
  layout: HistoryLayout = 'raw',
) {
  const t = historyTablesSchema.parse(input);
  const bucket = (alias: string) =>
    layout === 'customer-bucket-v1'
      ? `${alias}.customer_bucket=MOD(CAST(@customer AS INT64),1024)`
      : 'TRUE';
  return `WITH owned_order AS (SELECT id FROM \`${t.orders}\` o WHERE user_id=CAST(@customer AS INT64) AND id=CAST(@order AS INT64) AND ${bucket('o')}),
    page AS (SELECT hp.id AS line_id,CAST(hp.id AS STRING) AS id,CAST(hp.prod_id AS STRING) AS productId,p.product AS name
    FROM owned_order o INNER JOIN \`${t.lines}\` hp ON hp.order_id=o.id AND ${bucket('hp')} INNER JOIN \`${t.products}\` p ON p.id=hp.prod_id
    WHERE (@before='' OR hp.id<CAST(NULLIF(@before,'') AS INT64)) ORDER BY hp.id DESC LIMIT @pageSize)
    SELECT EXISTS(SELECT 1 FROM owned_order) AS orderFound,ARRAY(SELECT AS STRUCT id,productId,name FROM page ORDER BY line_id DESC) AS items`;
}
