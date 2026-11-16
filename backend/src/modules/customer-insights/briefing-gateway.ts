import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { currentRequestTrace } from '../../observability/context.js';
import {
  customerBriefing,
  type BriefingIdentity,
  type CustomerBriefing,
} from './briefing-contracts.js';
import { customerInsightContract, type CustomerBriefingOptions } from './briefing-options.js';

function unavailable() {
  return new AppError(
    503,
    'CUSTOMER_INSIGHTS_UNAVAILABLE',
    'Customer insights are unavailable. You can continue the sale.',
  );
}
export interface CustomerBriefingGateway {
  read(identity: BriefingIdentity, storeId: string): Promise<CustomerBriefing>;
}
export function customerBriefingGateway(
  config: Config,
  options: CustomerBriefingOptions,
  fetcher: typeof fetch = fetch,
): CustomerBriefingGateway {
  return {
    async read(identity, storeId) {
      if (
        !options.CUSTOMER_INSIGHTS_ENABLED ||
        options.CUSTOMER_INSIGHT_QUERY_CONTRACT !== customerInsightContract ||
        !options.CUSTOMER_INSIGHT_URL ||
        !options.CUSTOMER_INSIGHT_API_KEY
      )
        throw unavailable();
      if (
        options.CUSTOMER_INSIGHT_STORE_IDS.length &&
        !options.CUSTOMER_INSIGHT_STORE_IDS.includes(storeId)
      )
        throw new AppError(
          403,
          'CUSTOMER_INSIGHTS_STORE_DISABLED',
          'Customer insights are not enabled for this store.',
        );
      const url = new URL(options.CUSTOMER_INSIGHT_URL);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(
            config.NODE_ENV !== 'production' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          ))
      )
        throw unavailable();
      // Preserve source contact-first identity. Service IDs need not be POS IDs;
      // never send user_id alongside an email or telephone.
      if (identity.email.trim()) url.searchParams.set('email', identity.email.trim());
      if (identity.telephone.trim()) url.searchParams.set('telephone', identity.telephone.trim());
      if (!url.searchParams.has('email') && !url.searchParams.has('telephone'))
        url.searchParams.set('user_id', identity.id);
      url.searchParams.set('store_id', storeId);
      let response: Response;
      try {
        const trace = currentRequestTrace();
        response = await fetcher(url, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
          headers: {
            'X-API-Key': options.CUSTOMER_INSIGHT_API_KEY,
            'X-POS-Insights-Contract': customerInsightContract,
            ...(trace ? { 'X-Request-ID': trace.requestId } : {}),
          },
        });
      } catch {
        throw unavailable();
      }
      if (
        !response.ok ||
        response.headers.get('X-POS-Insights-Contract') !== customerInsightContract
      )
        throw unavailable();
      try {
        const raw = await boundedJson(response, 256000);
        const envelope = z
          .object({ success: z.boolean().optional(), data: z.unknown().optional() })
          .passthrough()
          .safeParse(raw);
        if (!envelope.success || envelope.data.success === false) throw unavailable();
        const briefing = customerBriefing.parse(envelope.data.data ?? raw);
        // Only product images from approved origins reach the browser. Cookies,
        // credentials, fragments and non-HTTPS schemes never leave this seam.
        const allowed = new Set(options.CUSTOMER_INSIGHT_IMAGE_ORIGINS);
        return {
          ...briefing,
          action_points: briefing.action_points.map((point) => ({
            ...point,
            items: point.items.map((item) => {
              let image: string | null = null;
              if (item.image_url)
                try {
                  const parsed = new URL(item.image_url);
                  if (
                    parsed.protocol === 'https:' &&
                    !parsed.username &&
                    !parsed.password &&
                    !parsed.hash &&
                    allowed.has(parsed.origin)
                  )
                    image = parsed.href;
                } catch {
                  /* Invalid image becomes the accessible empty thumbnail. */
                }
              return { ...item, image_url: image };
            }),
          })),
        };
      } catch {
        throw unavailable();
      }
    },
  };
}
