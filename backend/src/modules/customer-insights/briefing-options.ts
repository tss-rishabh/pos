import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const customerInsightContract = 'pos-customer-insights-bigquery-private-v1';
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function readCustomerBriefingOptions(env: NodeJS.ProcessEnv = process.env) {
  const values = z
    .object({
      CUSTOMER_INSIGHTS_ENABLED: z.preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      ),
      CUSTOMER_INSIGHT_URL: optional(z.url()),
      CUSTOMER_INSIGHT_API_KEY: optional(z.string().min(16).max(4096)),
      CUSTOMER_INSIGHT_QUERY_CONTRACT: optional(z.literal(customerInsightContract)),
      CUSTOMER_INSIGHT_STORE_IDS: z
        .string()
        .max(10000)
        .default('')
        .transform((value) =>
          value.trim() ? value.split(',').map((id) => identifier.parse(id.trim())) : [],
        ),
      CUSTOMER_INSIGHT_IMAGE_ORIGINS: z
        .string()
        .max(10000)
        .default('https://prod-img.thesouledstore.com')
        .transform((value) =>
          value
            .split(',')
            .filter(Boolean)
            .map((origin) => {
              const url = new URL(origin.trim());
              if (
                url.protocol !== 'https:' ||
                url.username ||
                url.password ||
                url.pathname !== '/' ||
                url.search ||
                url.hash
              )
                throw new Error('Configure exact HTTPS customer insight image origins.');
              return url.origin;
            }),
        ),
    })
    .parse(env);
  return values;
}
export type CustomerBriefingOptions = ReturnType<typeof readCustomerBriefingOptions>;
