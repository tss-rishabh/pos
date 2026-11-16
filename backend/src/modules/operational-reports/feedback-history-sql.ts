import {
  feedbackHistoryOptions,
  feedbackHistoryOptionsSchema,
  type FeedbackHistoryOptions,
} from './feedback-history-options.js';

/** The optional view is facts only: current dimensions never enter warehouse filtering. */
export function feedbackHistorySql(options: FeedbackHistoryOptions = feedbackHistoryOptions()) {
  options = feedbackHistoryOptionsSchema.parse(options);
  const source = options.BQ_CUSTOMER_FEEDBACK_VIEW
    ? `SELECT feedback_id,store_row_id,order_id,customer_id,store_id,question_id,feedback,feedback_date,order_date FROM \`${options.BQ_CUSTOMER_FEEDBACK_VIEW}\``
    : `SELECT nf.id AS feedback_id,os.id AS store_row_id,o.id AS order_id,o.user_id AS customer_id,os.store_id,nf.question_id,nf.feedback_answer AS feedback,nf.created_at AS feedback_date,o.created_at AS order_date
     FROM \`${options.BQ_CUSTOMER_FEEDBACK_TABLE}\` nf LEFT JOIN \`${options.BQ_CUSTOMER_FEEDBACK_ORDERS_TABLE}\` o ON o.id=nf.order_id
     LEFT JOIN \`${options.BQ_CUSTOMER_FEEDBACK_ORDER_STORES_TABLE}\` os ON os.order_id=o.id`;
  return `WITH source_facts AS (${source}),filtered AS (
    SELECT *,ROW_NUMBER() OVER(ORDER BY order_id DESC,feedback_id DESC,store_row_id DESC NULLS LAST) AS position FROM source_facts
    WHERE order_id>0 AND order_date>=@start AND order_date<=@end
      AND (@allStores OR CAST(store_id AS STRING) IN UNNEST(@stores))
      AND (@allOrders OR CAST(order_id AS STRING) IN UNNEST(@orders))
      AND (@allCustomers OR CAST(customer_id AS STRING) IN UNNEST(@customers))
  ),counts AS (SELECT COUNT(*) AS total FROM filtered),paging AS (
    SELECT total,IF(@page>CEIL(SAFE_DIVIDE(total,@pageSize)),1,@page) AS page FROM counts
  ) SELECT CAST(total AS STRING) AS total,page,ARRAY(
    SELECT AS STRUCT CAST(order_id AS STRING) AS orderId,CAST(customer_id AS STRING) AS customerId,
      CAST(store_id AS STRING) AS associatedStoreId,CAST(question_id AS STRING) AS questionId,feedback,
      FORMAT_DATETIME('%F %T',feedback_date) AS feedbackDate,FORMAT_DATETIME('%F %T',order_date) AS orderDate
    FROM filtered WHERE position>(paging.page-1)*@pageSize AND position<=paging.page*@pageSize ORDER BY position
  ) AS items FROM paging`;
}
