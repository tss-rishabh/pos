import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { orderHistoryContract } from './contracts.js';
const view = z.string().regex(/^[a-z][a-z0-9-]{4,62}\.[A-Za-z_]\w{0,1023}\.[A-Za-z_]\w{0,1023}$/);
export function readOrderHistoryOptions(env: NodeJS.ProcessEnv = process.env) {
  const optional = z.preprocess((value) => (value === '' ? undefined : value), view.optional());
  return z
    .object({
      ORDER_HISTORY_CONTRACT: z.string().optional(),
      BQ_ORDER_HISTORY_HEADERS_VIEW: optional,
      BQ_ORDER_HISTORY_STORES_VIEW: optional,
      BQ_ORDER_HISTORY_LINES_VIEW: optional,
      BQ_ORDER_HISTORY_PUBLICATIONS_VIEW: optional,
      ORDER_HISTORY_MAX_LAG_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
      ORDER_HISTORY_MAX_ORDER_LINES: z.coerce.number().int().min(100).max(50000).default(10000),
    })
    .parse(env);
}
export type OrderHistoryOptions = ReturnType<typeof readOrderHistoryOptions>;
export const historyRequired = () =>
  new AppError(
    503,
    'ORDER_HISTORY_PUBLICATION_REQUIRED',
    'A complete historical order publication is required for these dates.',
  );
export const historyInvalid = () =>
  new AppError(
    503,
    'ORDER_HISTORY_PUBLICATION_INVALID',
    'The historical order publication could not be verified. Refresh or try again later.',
  );
export function qualifiedOrderViews(options: OrderHistoryOptions) {
  if (
    options.ORDER_HISTORY_CONTRACT !== orderHistoryContract ||
    !options.BQ_ORDER_HISTORY_HEADERS_VIEW ||
    !options.BQ_ORDER_HISTORY_STORES_VIEW ||
    !options.BQ_ORDER_HISTORY_LINES_VIEW ||
    !options.BQ_ORDER_HISTORY_PUBLICATIONS_VIEW
  )
    throw historyRequired();
  return {
    headers: view.parse(options.BQ_ORDER_HISTORY_HEADERS_VIEW),
    stores: view.parse(options.BQ_ORDER_HISTORY_STORES_VIEW),
    lines: view.parse(options.BQ_ORDER_HISTORY_LINES_VIEW),
    publications: view.parse(options.BQ_ORDER_HISTORY_PUBLICATIONS_VIEW),
  };
}
