import { Temporal } from '@js-temporal/polyfill';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { ExclusiveUser, MUser } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import { identifier } from '../../../domain/validation.js';
import type { AppCashbackCampaign } from '../../customer-insights/benefits-gateway.js';
import { customerMembership } from '../../customer-insights/benefits-values.js';
import { tracedFetch } from '../../../observability/context.js';

/**
 * Legacy "Fetch the User" (`create_order.html:2905-2984`) → `AjaxUserDetailsView`
 * (`users/views.py:612-664`): API-v2 `check-user-exclusive` decides whether the customer can be
 * found (it answers 404 with its own message for blocked or unknown customers), then the POS adds
 * the exclusive membership (`Helpers.get_exclusive_user`, `helpers/helpers.py:254-281`) and the app
 * cashback eligibility (`Helpers.check_app_user_eligibility`, `helpers/helpers.py:1804-1843`).
 */
const text = z
  .string()
  .max(254)
  .regex(/^[^\u0000-\u001f\u007f]*$/u);
/**
 * Legacy form: `telephone` from the `9999999999` input mask and a free `email` input, both posted.
 * An incomplete mask (contains `_`) or a blank telephone becomes `0` (`users/views.py:617-621`).
 */
export const customerLookupBodySchema = z
  .object({
    counterId: identifier,
    telephone: z.string().max(32).default(''),
    email: text.default(''),
  })
  .strict();
export type CustomerLookupBody = z.infer<typeof customerLookupBodySchema>;
export interface CustomerLookupQuery {
  email: string;
  telephone: string | 0;
}
/** Applies the legacy normalisation; null when neither field is usable. */
export function customerLookupQuery(body: Pick<CustomerLookupBody, 'telephone' | 'email'>) {
  const email = body.email.trim(),
    raw = body.telephone.trim(),
    telephone = !raw || raw.includes('_') ? 0 : raw;
  if (telephone !== 0 && !/^\d{1,15}$/.test(telephone))
    throw new AppError(400, 'CUSTOMER_LOOKUP_INVALID', 'Please Provide Email/Telephone.');
  if (!email && telephone === 0)
    throw new AppError(400, 'CUSTOMER_LOOKUP_INVALID', 'Please Provide Email/Telephone.');
  return { email, telephone } satisfies CustomerLookupQuery;
}

const upstreamCustomer = z
  .object({
    user_id: z.union([identifier, z.number().int().positive().safe()]),
    name: z.string().max(200).nullish(),
    telephone: z.union([z.string().max(32), z.number().int().nonnegative().safe()]).nullish(),
    email: z.string().max(254),
    customer_type: z.string().max(8).nullish(),
    gstin: z.string().max(32).nullish(),
  })
  .passthrough();
const upstreamFound = z.object({ message: z.string().max(500).optional(), data: upstreamCustomer });
const upstreamMessage = z.object({ message: z.string().max(500) }).passthrough();

export type CheckUserExclusiveResult =
  | { kind: 'found'; message: string; customer: z.infer<typeof upstreamCustomer> }
  | { kind: 'not-found'; message: string };
export interface CheckUserExclusiveAdapter {
  check(query: CustomerLookupQuery): Promise<CheckUserExclusiveResult>;
}
export function customerLookupOptions(env: NodeJS.ProcessEnv = process.env) {
  const optional = z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().max(1024).optional(),
  );
  return z
    .object({
      // POSAdmin/settings.py: API-v2 application credentials sent as `Ar_app_id`/`Ar_app_key`.
      API_V2_APP_ID: optional,
      API_V2_APP_KEY: optional,
    })
    .parse(env);
}
const unavailable = () =>
  new AppError(
    503,
    'CUSTOMER_LOOKUP_UNAVAILABLE',
    'Unable to fetch user details. Please try again.',
  );
const clean = (message: string) =>
  message.replace(/[\u0000-\u001f\u007f<>]/gu, ' ').trim() || 'User Not Found.';

/**
 * `POST {API-v2}check-user-exclusive` `{email, telephone}` with `Content-Type`, `Ar_app_id` and
 * `Ar_app_key` only, timeout 10 s (`users/views.py:623-643`). The base is the checkout API-v2 base
 * (`TSS_API_BASE_URL`, legacy `MAIN_API_V2_URL`/`API_V2_URL`; the segment is the same for both).
 */
export function checkUserExclusiveAdapter(
  config: Pick<Config, 'TSS_API_BASE_URL' | 'NODE_ENV'>,
  options = customerLookupOptions(),
  fetcher: typeof fetch = tracedFetch,
): CheckUserExclusiveAdapter {
  function target() {
    if (!config.TSS_API_BASE_URL || !options.API_V2_APP_ID || !options.API_V2_APP_KEY)
      throw new AppError(
        503,
        'CUSTOMER_LOOKUP_NOT_CONFIGURED',
        'Customer lookup is not configured.',
      );
    const base = new URL(config.TSS_API_BASE_URL);
    if (
      base.username ||
      base.password ||
      (base.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(base.hostname)))
    )
      throw new AppError(
        503,
        'CUSTOMER_LOOKUP_NOT_CONFIGURED',
        'Customer lookup is not configured.',
      );
    return new URL('check-user-exclusive', base.href.endsWith('/') ? base.href : base.href + '/');
  }
  return {
    async check(query) {
      const url = target();
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Ar_app_id: options.API_V2_APP_ID ?? '',
            Ar_app_key: options.API_V2_APP_KEY ?? '',
          },
          body: JSON.stringify({ email: query.email, telephone: query.telephone }),
          // Security decision: application credentials are never forwarded across a redirect.
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw unavailable();
      }
      if (response.status === 200) {
        let parsed: z.infer<typeof upstreamFound>;
        try {
          parsed = upstreamFound.parse(await boundedJson(response, 256_000));
        } catch {
          // Legacy `data['data']` KeyError is a 500; nothing is connected from an unreadable body.
          throw new AppError(
            502,
            'CUSTOMER_LOOKUP_INVALID_RESPONSE',
            'Unable to fetch user details. Please try again.',
          );
        }
        return { kind: 'found', message: parsed.message ?? '', customer: parsed.data };
      }
      if (response.status === 404) {
        // Blocked or unknown customers: legacy relays the API-v2 message (`users/views.py:656-659`).
        try {
          const parsed = upstreamMessage.safeParse(await boundedJson(response, 64_000));
          return {
            kind: 'not-found',
            message: parsed.success ? clean(parsed.data.message) : 'User Not Found.',
          };
        } catch {
          return { kind: 'not-found', message: 'User Not Found.' };
        }
      }
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'not-found', message: 'User Not Found.' };
    },
  };
}

export interface CustomerLookupResult {
  customer: {
    id: string;
    name: string;
    telephone: string;
    email: string;
    customerType: string;
    gstin: string;
  };
  message: string;
  /** `Helpers.get_exclusive_user`: `{member, expiry, message}`. */
  exclusive: { member: boolean; expiry: string | null; message: string };
  /** `Helpers.check_app_user_eligibility(...)[0]`. */
  discountEligible: boolean;
}
export interface CustomerLookupService {
  lookup(body: Pick<CustomerLookupBody, 'telephone' | 'email'>): Promise<CustomerLookupResult>;
}
export interface CustomerLookupDependencies {
  adapter: CheckUserExclusiveAdapter;
  campaign: AppCashbackCampaign;
  now?: () => number;
}
export function customerLookupService(
  db: Databases,
  config: Pick<Config, 'BUSINESS_TIMEZONE'>,
  dependencies: CustomerLookupDependencies,
): CustomerLookupService {
  const now = dependencies.now ?? Date.now;
  async function exclusive(email: string): Promise<CustomerLookupResult['exclusive']> {
    const [row] = await db
      .get('primary')
      .select({ value: ExclusiveUser.value, active: ExclusiveUser.is_active })
      .from(ExclusiveUser)
      .where(and(eq(ExclusiveUser.entity, email), eq(ExclusiveUser.attribute, 'EXCLUSIVE_EXPIRY')))
      .limit(1);
    const value = customerMembership(
      row,
      Temporal.Instant.fromEpochMilliseconds(now())
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime(),
    );
    return { member: value.active, expiry: value.expiry, message: value.message };
  }
  /** A failed CMS read is "not eligible", as legacy (`app_cash_data = False`). */
  async function discountEligible(customerId: string) {
    if ((await dependencies.campaign.active()) !== true) return false;
    const [storefront] = await db
      .get('primary')
      .select({ id: MUser.id })
      .from(MUser)
      .where(and(eq(MUser.id, BigInt(customerId)), eq(MUser.user_platform, 'STORE_FRONT_USER')))
      .limit(1);
    return !storefront;
  }
  return {
    async lookup(body) {
      const query = customerLookupQuery(body),
        found = await dependencies.adapter.check(query);
      if (found.kind === 'not-found') throw new AppError(404, 'CUSTOMER_NOT_FOUND', found.message);
      const upstream = found.customer,
        id = String(upstream.user_id);
      const [membership, eligible] = await Promise.all([
        exclusive(upstream.email),
        discountEligible(id),
      ]);
      return {
        customer: {
          id,
          name: upstream.name ?? '',
          telephone:
            upstream.telephone === null || upstream.telephone === undefined
              ? ''
              : String(upstream.telephone),
          email: upstream.email,
          customerType: upstream.customer_type ?? '',
          gstin: upstream.gstin ?? '',
        },
        message: found.message,
        exclusive: membership,
        discountEligible: eligible,
      };
    },
  };
}
