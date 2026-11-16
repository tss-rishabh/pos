import { z } from 'zod';
import { unavailable } from '../../domain/errors.js';
const table = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
    'Use a fully qualified project.dataset.table name.',
  )
  .optional();
export function monitoringOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_FULFILLMENT_EXPRESS_LINES: table,
      BQ_FULFILLMENT_ORDERS: table,
      BQ_FULFILLMENT_HAS_PRODUCTS: table,
      BQ_FULFILLMENT_PRODUCTS: table,
      BQ_FULFILLMENT_STORES: table,
      BQ_FULFILLMENT_ORDER_STATUSES: table,
      BQ_FULFILLMENT_PAYMENT_STATUSES: table,
      BQ_FULFILLMENT_STATUS_LOGS: table,
    })
    .parse(env);
}
export type MonitoringOptions = ReturnType<typeof monitoringOptions>;
export function monitoringTable(options: MonitoringOptions, key: keyof MonitoringOptions): string {
  const name = options[key];
  if (!name)
    return unavailable(
      `BigQuery fulfillment ${key.replace('BQ_FULFILLMENT_', '').toLowerCase()} table`,
    );
  return '`' + name + '`';
}
