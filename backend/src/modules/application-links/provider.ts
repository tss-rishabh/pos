import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { safeApplicationDestination, type ApplicationLinkOptions } from './contracts.js';
import { sourceCustomerLinkBody } from './domain.js';

export interface CustomerApplicationProvider {
  readonly configurationVersion: string;
  destination(storeId: string, operationId: string): Promise<string>;
  accepts(destination: string): boolean;
}
const unavailable = () =>
  new AppError(
    503,
    'CUSTOMER_APPLICATION_UNAVAILABLE',
    'The customer application link is temporarily unavailable.',
  );
export function createCustomerApplicationProvider(
  config: Pick<Config, 'DEMO_MODE'>,
  options: ApplicationLinkOptions,
  fetcher: typeof fetch = fetch,
): CustomerApplicationProvider | undefined {
  if (config.DEMO_MODE || options.POS_CUSTOMER_APP_MODE === 'disabled') return undefined;
  const accepts = (value: string) =>
      safeApplicationDestination(value, options.POS_CUSTOMER_APP_ORIGINS),
    configurationVersion = createHash('sha256')
      .update(
        JSON.stringify({
          mode: options.POS_CUSTOMER_APP_MODE,
          endpoint: options.POS_CUSTOMER_APP_LINK_ENDPOINT,
          contract: options.POS_CUSTOMER_APP_LINK_CONTRACT,
          origins: options.POS_CUSTOMER_APP_ORIGINS,
          website: options.POS_CUSTOMER_APP_WEBSITE,
          fallback: options.POS_APP_REDIRECT,
        }),
      )
      .digest('hex');
  return {
    configurationVersion,
    accepts,
    async destination(storeId, operationId) {
      if (!/^[1-9]\d{0,9}$/.test(storeId) || BigInt(storeId) > 2147483647n) throw unavailable();
      if (options.POS_CUSTOMER_APP_MODE === 'fallback') return options.POS_APP_REDIRECT;
      if (!options.POS_CUSTOMER_APP_LINK_ENDPOINT || !options.POS_CUSTOMER_APP_LINK_CONTRACT)
        throw unavailable();
      try {
        const response = await fetcher(options.POS_CUSTOMER_APP_LINK_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': z.uuid().parse(operationId),
          },
          body: JSON.stringify(sourceCustomerLinkBody(storeId, options.POS_CUSTOMER_APP_WEBSITE)),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw unavailable();
        const parsed = z
          .object({ object: z.object({ shortLink: z.string().max(2048).nullish() }).nullish() })
          .parse(await boundedJson(response, 32768));
        const target = parsed.object?.shortLink || options.POS_APP_REDIRECT;
        if (!accepts(target)) throw unavailable();
        return target;
      } catch {
        throw unavailable();
      }
    },
  };
}
