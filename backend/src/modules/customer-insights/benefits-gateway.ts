import { z } from 'zod';
import type { Config } from '../../config.js';
import { boundedJson } from '../../domain/http-json.js';
import { tracedFetch } from '../../observability/context.js';

const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
export function customerBenefitOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      // Legacy `TEN_PER_SWITCH = True if int(ENV.get("TEN_PER_SWITCH", 1)) else False`
      // (POSAdmin/settings.py:542): default on, legacy integers accepted (W4 fix).
      TEN_PER_SWITCH: z.preprocess(
        (value) =>
          value === undefined
            ? true
            : typeof value === 'string' && /^\s*[+-]?\d+(?:_\d+)*\s*$/.test(value)
              ? Number(value.trim().replaceAll('_', '')) !== 0
              : value,
        flag,
      ),
      STAGING_CMS_ENDPOINT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.url().optional(),
      ),
    })
    .parse(env);
}
export interface AppCashbackCampaign {
  /** null means unavailable; the display cannot promise eligibility from a failed lookup. */
  active(): Promise<boolean | null>;
}
const providerFlag = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean);
const campaignResponse = z.object({
  data: z
    .array(
      z.object({
        is_app: providerFlag,
        status: providerFlag.optional().default(false),
      }),
    )
    .max(1000),
});
export function appCashbackCampaign(
  config: Config,
  options = customerBenefitOptions(),
  fetcher: typeof fetch = tracedFetch,
  clock: () => number = Date.now,
): AppCashbackCampaign {
  let cached: { value: boolean | null; until: number } | undefined;
  let inFlight: Promise<boolean | null> | undefined;
  async function load(): Promise<boolean | null> {
    try {
      if (!options.STAGING_CMS_ENDPOINT) return null;
      const url = new URL(options.STAGING_CMS_ENDPOINT);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
          !(
            config.NODE_ENV !== 'production' &&
            url.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          ))
      )
        return null;
      url.pathname = '/api/v2/faq/app-cashback';
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200) return null;
      const result = campaignResponse.parse(await boundedJson(response, 128000));
      // Source's loop selects the last app campaign, including a disabled final row.
      return result.data.filter((item) => item.is_app).at(-1)?.status ?? false;
    } catch {
      return null;
    }
  }
  return {
    async active() {
      if (!options.TEN_PER_SWITCH) return false;
      if (cached && cached.until > clock()) return cached.value;
      inFlight ??= load()
        .then((value) => {
          cached = { value, until: clock() + (value === null ? 1000 : 30000) };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
