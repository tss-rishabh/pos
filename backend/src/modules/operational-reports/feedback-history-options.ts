import { z } from 'zod';

const relation = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  );
export const feedbackHistoryOptionsSchema = z.object({
  BQ_CUSTOMER_FEEDBACK_VIEW: relation.optional(),
  BQ_CUSTOMER_FEEDBACK_TABLE: relation.default('tssgcp2025.tss_mysql_raw_layer.tss_nps_feedback'),
  BQ_CUSTOMER_FEEDBACK_ORDERS_TABLE: relation.default('tssgcp2025.tss_mysql_raw_layer.tss_orders'),
  BQ_CUSTOMER_FEEDBACK_ORDER_STORES_TABLE: relation.default(
    'tssgcp2025.tss_mysql_raw_layer.tss_order_stores',
  ),
});
export function feedbackHistoryOptions(env: NodeJS.ProcessEnv = process.env) {
  return feedbackHistoryOptionsSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
}
export type FeedbackHistoryOptions = ReturnType<typeof feedbackHistoryOptions>;
