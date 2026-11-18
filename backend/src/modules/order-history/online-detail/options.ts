import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { onlineOrderDetailContract } from './contracts.js';
const view = z.string().regex(/^[a-z][a-z0-9-]{4,62}\.[A-Za-z_]\w{0,1023}\.[A-Za-z_]\w{0,1023}$/);
const optional = z.preprocess((value) => (value === '' ? undefined : value), view.optional());
export function readOnlineDetailOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      ORDER_DETAIL_CONTRACT: z.string().optional(),
      BQ_ORDER_DETAIL_FACTS_VIEW: optional,
      BQ_ORDER_DETAIL_PUBLICATIONS_VIEW: optional,
      ORDER_DETAIL_MAX_LAG_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
    })
    .parse(env);
}
export type OnlineDetailOptions = ReturnType<typeof readOnlineDetailOptions>;
export const detailPublicationRequired = () =>
  new AppError(
    503,
    'ORDER_DETAIL_PUBLICATION_REQUIRED',
    'Complete historical order details are not available.',
  );
export function qualifiedDetailViews(options: OnlineDetailOptions) {
  if (
    options.ORDER_DETAIL_CONTRACT !== onlineOrderDetailContract ||
    !options.BQ_ORDER_DETAIL_FACTS_VIEW ||
    !options.BQ_ORDER_DETAIL_PUBLICATIONS_VIEW
  )
    throw detailPublicationRequired();
  return {
    facts: options.BQ_ORDER_DETAIL_FACTS_VIEW,
    publications: options.BQ_ORDER_DETAIL_PUBLICATIONS_VIEW,
  };
}
