import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import {
  customerBriefing,
  type BriefingIdentity,
  type CustomerBriefing,
} from './briefing-contracts.js';
import type { CustomerBriefingOptions } from './briefing-options.js';
import { tracedFetch } from '../../observability/context.js';

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
  fetcher: typeof fetch = tracedFetch,
): CustomerBriefingGateway {
  return {
    async read(identity, storeId) {
      // Legacy AjaxCustomerInsightView (users/views.py:697-801): GET CUSTOMER_INSIGHT_URL with
      // X-API-Key (omitted when the key is empty), contact-first identity and store_id.
      if (!options.CUSTOMER_INSIGHT_URL) throw unavailable();
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
        response = await fetcher(url, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
          headers: options.CUSTOMER_INSIGHT_API_KEY
            ? { 'X-API-Key': options.CUSTOMER_INSIGHT_API_KEY }
            : {},
        });
      } catch {
        throw unavailable();
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw unavailable();
      }
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
