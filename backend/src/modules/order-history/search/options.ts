import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { sourceSearchContract } from './contracts.js';
const view = z.string().regex(/^[a-z][a-z0-9-]{4,62}\.[A-Za-z_]\w{0,1023}\.[A-Za-z_]\w{0,1023}$/),
  optional = z.preprocess((value) => (value === '' ? undefined : value), view.optional());
export function readOrderSearchOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      ORDER_SEARCH_CONTRACT: z.string().optional(),
      BQ_ORDER_SEARCH_INDEX_VIEW: optional,
      BQ_ORDER_SEARCH_FACTS_VIEW: optional,
      BQ_ORDER_SEARCH_PUBLICATIONS_VIEW: optional,
      ORDER_SEARCH_CONTACT_KEY: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().min(32).max(1024).optional(),
      ),
      ORDER_SEARCH_CONTACT_KEY_ID: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .regex(/^[A-Za-z0-9_-]{8,64}$/)
          .optional(),
      ),
      ORDER_SEARCH_MAX_LAG_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
      ORDER_SEARCH_MAX_INDEX_ROWS: z.coerce.number().int().min(1000).max(50000).default(20000),
      ORDER_SEARCH_MAX_QUEUE_ORDERS: z.coerce.number().int().min(100).max(10000).default(10000),
    })
    .parse(env);
}
export type OrderSearchOptions = ReturnType<typeof readOrderSearchOptions>;
export const searchPublicationRequired = () =>
  new AppError(
    503,
    'ORDER_SEARCH_PUBLICATION_REQUIRED',
    'This selection requires a complete qualified historical order-search publication.',
  );
export const searchPublicationInvalid = () =>
  new AppError(
    503,
    'ORDER_SEARCH_PUBLICATION_INVALID',
    'The historical order-search publication could not be verified. Refresh this selection.',
  );
export function qualifiedSearchViews(options: OrderSearchOptions) {
  if (
    options.ORDER_SEARCH_CONTRACT !== sourceSearchContract ||
    !options.BQ_ORDER_SEARCH_INDEX_VIEW ||
    !options.BQ_ORDER_SEARCH_FACTS_VIEW ||
    !options.BQ_ORDER_SEARCH_PUBLICATIONS_VIEW ||
    !options.ORDER_SEARCH_CONTACT_KEY ||
    !options.ORDER_SEARCH_CONTACT_KEY_ID
  )
    throw searchPublicationRequired();
  return {
    index: options.BQ_ORDER_SEARCH_INDEX_VIEW,
    facts: options.BQ_ORDER_SEARCH_FACTS_VIEW,
    publications: options.BQ_ORDER_SEARCH_PUBLICATIONS_VIEW,
  };
}
