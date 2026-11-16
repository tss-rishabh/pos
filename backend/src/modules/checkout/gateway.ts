import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import type { Payload } from './payloads.js';
import { stringifyNumericJson } from '../upstream.js';
import { currentRequestTrace } from '../../observability/context.js';
import {
  assertCustomerContextReady,
  checkoutTokenSubject,
  customerContextContract,
  usesCustomerContext,
  type CustomerContextConfiguration,
} from './customer-context.js';
import {
  membershipContextContract,
  verifiedMembershipContext,
} from './cancellations/membership-context.js';
import { giftCardContract } from './gift-card-issuance.js';
import {
  customerConsentContract,
  assertCustomerConsentReady,
  signCustomerConsent,
  type CustomerConsent,
  type CustomerConsentConfiguration,
} from './customer-consent.js';
import {
  assertCheckoutProjectionReady,
  type CheckoutProjectionConfiguration,
} from './projection.js';
import {
  assertRefundAllocationReady,
  refundAllocationContract,
  refundSourcePatchHash,
  type RefundAllocationConfiguration,
} from './refund-allocation.js';

export interface CheckoutEnvironment
  extends
    CheckoutProjectionConfiguration,
    RefundAllocationConfiguration,
    CustomerContextConfiguration {
  membershipContextContract?: typeof membershipContextContract;
  customerConsentContract?: CustomerConsentConfiguration['customerConsentContract'];
  hs256?: string;
  hs512?: string;
  paymentOrderUrl?: string;
  postOrderBaseUrl?: string;
  pineBaseUrl?: string;
  returnRefundUrl?: string;
  returnSecret?: string;
  giftCardSalt?: string;
  exchangeStockContract?: string;
  giftCardContract?: string;
  giftCardExpiryDays?: number;
}
export function checkoutEnvironment(env: NodeJS.ProcessEnv = process.env): CheckoutEnvironment {
  const value = z
    .object({
      TSS_JWT_HS256_KEY: z.string().min(32).optional(),
      TSS_JWT_HS512_KEY: z.string().min(32).optional(),
      TSS_PAYMENT_ORDER_URL: z.url().optional(),
      TSS_POST_ORDER_BASE_URL: z.url().optional(),
      TSS_PINELABS_BASE_URL: z.url().optional(),
      TSS_RETURN_REFUND_URL: z.url().optional(),
      TSS_RETURN_SECRET: z.string().min(16).optional(),
      TSS_GIFT_CARD_SALT: z.string().min(16).optional(),
      UPSTREAM_POS_MEMBERSHIP_CONTEXT_CONTRACT: z.literal(membershipContextContract).optional(),
      UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT: z.literal(customerContextContract).optional(),
      TSS_POS_CUSTOMER_CONTEXT_KEY: z
        .string()
        .regex(/^[\x21-\x7e]{32,4096}$/)
        .optional(),
      UPSTREAM_POS_EXCHANGE_STOCK_CONTRACT: z.literal('pos-exchange-stock-v1').optional(),
      UPSTREAM_POS_GIFT_CARD_CONTRACT: z.literal(giftCardContract).optional(),
      UPSTREAM_POS_CHECKOUT_PROJECTION_CONTRACT: z.literal('pos-checkout-projection-v1').optional(),
      TSS_POS_CHECKOUT_PROJECTION_KEY: z
        .string()
        .regex(/^[\x21-\x7e]{32,4096}$/)
        .optional(),
      UPSTREAM_POS_REFUND_ALLOCATION_CONTRACT: z.literal(refundAllocationContract).optional(),
      UPSTREAM_POS_REFUND_ALLOCATION_PATCH_HASH: z.literal(refundSourcePatchHash).optional(),
      DEFAULT_GC_EX_DAYS: z.coerce.number().int().min(1).max(36500).default(90),
      UPSTREAM_POS_CUSTOMER_CONSENT_CONTRACT: z.literal(customerConsentContract).optional(),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  return {
    hs256: value.TSS_JWT_HS256_KEY,
    hs512: value.TSS_JWT_HS512_KEY,
    paymentOrderUrl: value.TSS_PAYMENT_ORDER_URL,
    postOrderBaseUrl: value.TSS_POST_ORDER_BASE_URL,
    pineBaseUrl: value.TSS_PINELABS_BASE_URL,
    returnRefundUrl: value.TSS_RETURN_REFUND_URL,
    returnSecret: value.TSS_RETURN_SECRET,
    giftCardSalt: value.TSS_GIFT_CARD_SALT,
    customerContextContract: value.UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT,
    membershipContextContract: value.UPSTREAM_POS_MEMBERSHIP_CONTEXT_CONTRACT,
    customerContextKey: value.TSS_POS_CUSTOMER_CONTEXT_KEY,
    exchangeStockContract: value.UPSTREAM_POS_EXCHANGE_STOCK_CONTRACT,
    giftCardContract: value.UPSTREAM_POS_GIFT_CARD_CONTRACT,
    checkoutProjectionContract: value.UPSTREAM_POS_CHECKOUT_PROJECTION_CONTRACT,
    checkoutProjectionKey: value.TSS_POS_CHECKOUT_PROJECTION_KEY,
    refundAllocationContract: value.UPSTREAM_POS_REFUND_ALLOCATION_CONTRACT,
    refundSourcePatchHash: value.UPSTREAM_POS_REFUND_ALLOCATION_PATCH_HASH,
    giftCardExpiryDays: value.DEFAULT_GC_EX_DAYS,
    customerConsentContract: value.UPSTREAM_POS_CUSTOMER_CONSENT_CONTRACT,
  };
}
export class CheckoutGatewayError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly uncertain: boolean,
    status = 502,
  ) {
    super(status, code, message);
  }
}
export interface CheckoutGateway {
  assertApiReady?(): void;
  api(path: string, payload: Payload, token?: string): Promise<unknown>;
  confirm(payload: Payload, token: string, consent?: CustomerConsent | null): Promise<unknown>;
  exchangeReasons(categoryId: string): Promise<unknown>;
}
export function checkoutGateway(
  config: Config,
  environment: CheckoutEnvironment,
  fetcher: typeof fetch = fetch,
): CheckoutGateway {
  async function send(
    url: string | undefined,
    payload: Payload,
    token?: string,
    method: 'POST' | 'GET' = 'POST',
    projection = false,
    customerId?: string,
    consent?: CustomerConsent | null,
  ): Promise<unknown> {
    if (!url)
      throw new AppError(
        503,
        'CHECKOUT_DEPENDENCY_UNAVAILABLE',
        'Checkout integration is not configured.',
      );
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      (parsed.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))
    )
      throw new AppError(
        503,
        'INVALID_CHECKOUT_CONFIGURATION',
        'Checkout integrations require HTTPS.',
      );
    let response: Response;
    const signedConsent = consent
      ? signCustomerConsent(consent, environment.checkoutProjectionKey ?? '')
      : null;
    const caller = currentRequestTrace();
    if (consent && caller?.userId && caller.userId !== consent.operatorId)
      throw new AppError(
        409,
        'CHECKOUT_OPERATOR_CHANGED',
        'This order belongs to a different operator.',
      );
    try {
      const trace = currentRequestTrace();
      response = await fetcher(parsed, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: token } : {}),
          ...(trace ? { 'X-Request-ID': trace.requestId } : {}),
          ...(customerId
            ? {
                'X-POS-Customer-Context-Key': environment.customerContextKey!,
                'X-POS-Customer-Context': customerContextContract,
                'X-POS-Customer-ID': customerId,
              }
            : {}),
          ...(projection ? { 'X-POS-Projection-Key': environment.checkoutProjectionKey! } : {}),
          ...(signedConsent && consent
            ? {
                'X-POS-Customer-Consent': signedConsent,
                'X-POS-Operator-ID': consent.operatorId,
              }
            : {}),
          ...(projection && trace?.userId && /^[1-9]\d{0,18}$/.test(trace.userId)
            ? { 'X-POS-Operator-ID': trace.userId }
            : {}),
        },
        body: method === 'POST' ? stringifyNumericJson(payload) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new CheckoutGatewayError(
        'CHECKOUT_OUTCOME_UNCERTAIN',
        'The checkout service did not confirm this operation. Review its status before retrying.',
        true,
      );
    }
    if (
      response.ok &&
      customerId &&
      (response.headers.get('X-POS-Customer-Context') !== customerContextContract ||
        response.headers.get('X-POS-Customer-ID') !== customerId)
    )
      throw new CheckoutGatewayError(
        'CUSTOMER_CONTEXT_PROOF_MISSING',
        'The checkout service did not confirm fresh customer context. Review the sale before retrying.',
        true,
      );
    if (
      response.ok &&
      customerId &&
      environment.membershipContextContract &&
      !verifiedMembershipContext(response.headers)
    )
      throw new CheckoutGatewayError(
        'MEMBERSHIP_CONTEXT_PROOF_MISSING',
        'The checkout service did not confirm fresh membership context. Review the sale before retrying.',
        true,
      );
    let body: unknown;
    try {
      body = await boundedJson(response);
    } catch {
      throw new CheckoutGatewayError(
        'CHECKOUT_OUTCOME_UNCERTAIN',
        'The checkout service returned an unreadable response. Review its status before retrying.',
        response.ok || response.status >= 500,
      );
    }
    if (!response.ok) {
      const error = z
        .object({ title: z.string().max(500).optional(), message: z.string().max(500).optional() })
        .passthrough()
        .safeParse(body);
      throw new CheckoutGatewayError(
        'CHECKOUT_REJECTED',
        error.success
          ? error.data.title || error.data.message || 'Checkout could not complete this operation.'
          : 'Checkout could not complete this operation.',
        response.status >= 500,
        response.status >= 500 ? 502 : 422,
      );
    }
    return body;
  }
  function path(base: string | undefined, segment: string) {
    if (!base) return undefined;
    return new URL(segment, base.endsWith('/') ? base : base + '/').href;
  }
  return {
    assertApiReady: () => {
      const raw = config.TSS_API_BASE_URL;
      if (!raw)
        throw new AppError(
          503,
          'CHECKOUT_DEPENDENCY_UNAVAILABLE',
          'Checkout integration is not configured.',
        );
      const parsed = new URL(raw);
      if (
        parsed.username ||
        parsed.password ||
        (parsed.protocol !== 'https:' &&
          !(
            config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname)
          ))
      )
        throw new AppError(
          503,
          'INVALID_CHECKOUT_CONFIGURATION',
          'Checkout integrations require HTTPS.',
        );
    },
    api: (segment, payload, token) => {
      if (segment === 'omnichannel-sendotp' || segment === 'omnichannel-verifyotp')
        throw new AppError(
          503,
          'CUSTOMER_VERIFICATION_SERVICE_UNAVAILABLE',
          'Customer verification requires the local purpose-bound delivery service.',
        );
      if (segment === 'pos/order') {
        assertCheckoutProjectionReady(environment);
        assertRefundAllocationReady(environment);
        assertCustomerConsentReady(environment);
      }
      let customerId: string | undefined;
      if (usesCustomerContext(segment)) {
        assertCustomerContextReady(environment);
        customerId = checkoutTokenSubject(token, environment);
        if (payload.is_pos !== true)
          throw new AppError(
            503,
            'CUSTOMER_CONTEXT_SCOPE_INVALID',
            'A scoped POS request is required for fresh customer context.',
          );
      }
      return send(
        path(config.TSS_API_BASE_URL, segment),
        payload,
        token,
        'POST',
        false,
        customerId,
      );
    },
    confirm: (payload, token, consent) => {
      assertCheckoutProjectionReady(environment);
      assertRefundAllocationReady(environment);
      assertCustomerConsentReady(environment);
      return send(environment.paymentOrderUrl, payload, token, 'POST', true, undefined, consent);
    },
    exchangeReasons: (categoryId) => {
      const url = path(environment.postOrderBaseUrl, 'list_of_reason/');
      if (!url)
        throw new AppError(
          503,
          'EXCHANGE_REASONS_UNAVAILABLE',
          'Exchange reasons are not configured.',
        );
      const parsed = new URL(url);
      parsed.searchParams.set('cat_id', categoryId);
      parsed.searchParams.set('reason_type', '2');
      return send(parsed.href, {}, undefined, 'GET');
    },
  };
}
