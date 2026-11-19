import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { stringifyNumericJson } from '../../upstream.js';
import { wireId } from '../payloads.js';
import { CheckoutGatewayError } from '../gateway.js';
import type { InboundReturn, LineEligibility, ReturnGateway } from './contracts.js';

export interface ReturnEnvironment {
  /** Legacy ORDER_RETURN_STATUS_CHECK_URL. */
  eligibilityUrl?: string;
  vinculumUrl?: string;
  vinculumOwner?: string;
  vinculumKey?: string;
  transporterCode?: string;
  /** Legacy ORDER_RETURN_PAY_AMT_TSS_MONEY. */
  refundUrl?: string;
  /** Legacy ORDER_RECEIPT_TOKEN sent as X-POS-Secret. */
  receiptSecret?: string;
  /** Legacy RETURN_PERIOD (days). */
  returnPeriodDays?: number;
  /** Legacy MJML_HOST (mailr). Unset: return/exchange mail is skipped, as `_notify_mailr` does. */
  mailHost?: string;
  /** Legacy SLACK_URL (common channel). */
  slackUrl?: string;
  /** Legacy COMMON_GROUP_ALERT_ON = int(env, 0). */
  commonGroupAlert?: boolean;
}
const legacyInt = z
  .string()
  .regex(/^\s*[+-]?\d+\s*$/)
  .transform((value) => Number(value.trim()));
export function returnEnvironment(env: NodeJS.ProcessEnv = process.env): ReturnEnvironment {
  const parsed = z
    .object({
      TSS_RETURN_ELIGIBILITY_URL: z.url().optional(),
      TSS_VINCULUM_RETURN_URL: z.url().optional(),
      TSS_VINCULUM_API_OWNER: z.string().min(1).optional(),
      TSS_VINCULUM_API_KEY: z.string().min(16).optional(),
      TSS_VINCULUM_TRANSPORTER_CODE: z.string().min(1).optional(),
      TSS_RETURN_REFUND_URL: z.url().optional(),
      TSS_RETURN_SECRET: z.string().min(16).optional(),
      TSS_RETURN_PERIOD_DAYS: z.coerce.number().int().min(0).max(3650).optional(),
      MJML_HOST: z.url().optional(),
      SLACK_URL: z.url().optional(),
      COMMON_GROUP_ALERT_ON: legacyInt.default(0),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  return {
    eligibilityUrl: parsed.TSS_RETURN_ELIGIBILITY_URL,
    vinculumUrl: parsed.TSS_VINCULUM_RETURN_URL,
    vinculumOwner: parsed.TSS_VINCULUM_API_OWNER,
    vinculumKey: parsed.TSS_VINCULUM_API_KEY,
    transporterCode: parsed.TSS_VINCULUM_TRANSPORTER_CODE,
    refundUrl: parsed.TSS_RETURN_REFUND_URL,
    receiptSecret: parsed.TSS_RETURN_SECRET,
    returnPeriodDays: parsed.TSS_RETURN_PERIOD_DAYS,
    mailHost: parsed.MJML_HOST,
    slackUrl: parsed.SLACK_URL,
    commonGroupAlert: parsed.COMMON_GROUP_ALERT_ON !== 0,
  };
}
export function inboundPayload(input: InboundReturn, transporterCode: string) {
  return {
    orderReturn: [
      {
        requestType: 'Request & Inbound',
        returnType: 'Delivered Return',
        returnBin: 'Saleable',
        order_location: input.locationCode,
        order_no: wireId(input.orderId),
        invoice_no: '',
        tracking_no: input.trackingNumber,
        status: 'Confirmed',
        custRetCode: '999999',
        return_date: input.returnDate,
        customer_name: input.customerName,
        customer_address1: input.address1,
        customer_address2: input.address2,
        customer_address3: '',
        customer_address4: '',
        customer_country: 'India',
        customer_state: wireId(input.state),
        customer_city: input.city,
        customer_pincode: input.pincode,
        customer_email: '',
        remarks: input.remarks,
        ...(input.exchange ? { category: 'Replacement' } : {}),
        transporter: transporterCode,
        items: [
          {
            lineno: '',
            ext_lineno: wireId(input.lineId),
            sku: wireId(input.productId),
            return_qty: input.quantity,
            return_reason: input.reason,
          },
        ],
      },
    ],
  };
}

const eligibilityLine = z
  .object({
    has_product_id: z.union([z.string(), z.number()]),
    is_applicable_for_return: z.number().optional(),
    is_applicable_for_exchange: z.number().optional(),
    applicable_for_return_message: z.string().max(4096).nullish(),
    applicable_for_exchange_message: z.string().max(4096).nullish(),
    estimate_return_date: z.string().nullish(),
    estimate_exchange_date: z.string().nullish(),
  })
  .passthrough();
const eligibilityResponse = z
  .object({
    orders: z.array(z.object({ products: z.array(z.unknown()) }).passthrough()).min(1),
  })
  .passthrough();

/** `Helpers.check_return_exchange_status` per-line shapes (helpers/helpers.py:1747-1775). */
export function lineEligibility(line: z.infer<typeof eligibilityLine>): LineEligibility {
  const returnFlag = line.is_applicable_for_return,
    exchangeFlag = line.is_applicable_for_exchange;
  return {
    return:
      returnFlag === 1
        ? { status: true, reason: '', upto: line.estimate_return_date ?? null }
        : {
            status: false,
            reason: returnFlag === 2 ? (line.applicable_for_return_message ?? '') : '',
            upto: line.estimate_return_date ?? null,
          },
    exchange:
      exchangeFlag === 1
        ? { status: true, reason: '', upto: line.estimate_exchange_date ?? null }
        : {
            status: false,
            reason: exchangeFlag === 2 ? (line.applicable_for_exchange_message ?? '') : '',
            upto: null,
          },
  };
}

export interface ReturnGatewayLog {
  warn(value: Record<string, unknown>, message: string): void;
}

export function returnGateway(
  config: Config,
  environment: ReturnEnvironment,
  fetcher: typeof fetch = fetch,
  log?: ReturnGatewayLog,
): ReturnGateway {
  const endpoint = (raw: string | undefined) => {
    if (!raw)
      throw new AppError(
        503,
        'RETURN_INTEGRATION_UNAVAILABLE',
        'Return integrations are not configured.',
      );
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new AppError(
        503,
        'RETURN_INTEGRATION_UNAVAILABLE',
        'Return integrations require HTTPS.',
      );
    return url;
  };
  async function exchange(
    url: string | undefined,
    body: string,
    headers: Record<string, string>,
    sideEffect: boolean,
    timeoutMs = 10000,
  ) {
    let response: Response;
    try {
      response = await fetcher(endpoint(url), {
        method: 'POST',
        body,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new CheckoutGatewayError(
        'RETURN_OUTCOME_UNCERTAIN',
        'The return service did not confirm this action.',
        sideEffect,
      );
    }
    let value: unknown;
    try {
      value = await boundedJson(response);
    } catch {
      throw new CheckoutGatewayError(
        'RETURN_RESPONSE_UNCONFIRMED',
        'The return service returned an invalid response.',
        sideEffect,
      );
    }
    return { status: response.status, ok: response.ok, value };
  }
  async function send(
    url: string | undefined,
    body: string,
    headers: Record<string, string>,
    sideEffect: boolean,
  ) {
    const result = await exchange(url, body, headers, sideEffect);
    if (!result.ok)
      throw new CheckoutGatewayError(
        'RETURN_DEPENDENCY_REJECTED',
        'The return service did not accept this action.',
        sideEffect && result.status >= 500,
        result.status < 500 ? 422 : 502,
      );
    return result.value;
  }
  /** Fire-and-log notification (legacy logs a non-200 and continues). */
  async function notify(resource: string, url: URL, payload: unknown, timeoutMs: number) {
    const trace = currentRequestTrace();
    try {
      const response = await fetcher(url, {
        method: 'POST',
        body: stringifyNumericJson(payload),
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok)
        log?.warn(
          {
            module: 'checkout',
            resource,
            eventId: `checkout.${resource}.rejected`,
            requestId: trace?.requestId ?? null,
            userId: trace?.userId ?? null,
            statusCode: response.status,
          },
          'Notification was not accepted',
        );
    } catch {
      log?.warn(
        {
          module: 'checkout',
          resource,
          eventId: `checkout.${resource}.failed`,
          requestId: trace?.requestId ?? null,
          userId: trace?.userId ?? null,
        },
        'Notification request failed',
      );
    }
  }
  function mailUrl(path: string) {
    if (!environment.mailHost) {
      const trace = currentRequestTrace();
      log?.warn(
        {
          module: 'checkout',
          resource: 'return-mail',
          eventId: 'checkout.return-mail.skipped',
          requestId: trace?.requestId ?? null,
          userId: trace?.userId ?? null,
        },
        'MJML_HOST not configured, skipping mail',
      );
      return null;
    }
    try {
      return new URL(path, endpoint(environment.mailHost));
    } catch {
      return null;
    }
  }
  async function orderEligibility(orderId: string, storeId: string, token: string) {
    const parsed = eligibilityResponse.parse(
      await send(
        environment.eligibilityUrl,
        stringifyNumericJson({
          order_id: orderId,
          isNewReturnExchangeText: true,
          is_store_req: 1,
          store_id: wireId(storeId),
        }),
        { 'Content-Type': 'application/json', Authorization: token },
        false,
      ),
    );
    const lines = new Map<string, LineEligibility>();
    // Legacy reads orders[0].products and skips nothing it can parse.
    for (const raw of parsed.orders[0]!.products) {
      const line = eligibilityLine.safeParse(raw);
      if (line.success) lines.set(String(line.data.has_product_id), lineEligibility(line.data));
    }
    return lines;
  }
  return {
    configured() {
      for (const raw of [
        environment.eligibilityUrl,
        environment.vinculumUrl,
        environment.refundUrl,
      ])
        endpoint(raw);
      if (
        !environment.vinculumOwner ||
        !environment.vinculumKey ||
        !environment.transporterCode ||
        !environment.receiptSecret ||
        environment.returnPeriodDays === undefined
      )
        throw new AppError(
          503,
          'RETURN_INTEGRATION_UNAVAILABLE',
          'Return integrations are not configured.',
        );
    },
    orderEligibility,
    async eligibility(orderId, storeId, lineId, token, kind = 'return') {
      const line = (await orderEligibility(orderId, storeId, token)).get(lineId);
      if (!line)
        throw new AppError(
          409,
          'RETURN_ELIGIBILITY_UNAVAILABLE',
          'Return eligibility was not provided for this line.',
        );
      const entry = kind === 'exchange' ? line.exchange : line.return;
      return { reason: entry.reason, allowed: entry.status, until: entry.upto };
    },
    async inbound(input) {
      const body = new URLSearchParams({
        ApiOwner: environment.vinculumOwner || '',
        ApiKey: environment.vinculumKey || '',
        RequestBody: stringifyNumericJson(inboundPayload(input, environment.transporterCode || '')),
      });
      const result = z
        .object({
          responseMessage: z.string(),
          requestStatus: z.object({ status: z.string() }).nullable(),
        })
        .parse(
          await send(
            environment.vinculumUrl,
            body.toString(),
            { 'Content-Type': 'application/x-www-form-urlencoded' },
            true,
          ),
        );
      if (result.responseMessage !== 'Success' || result.requestStatus?.status !== 'Success')
        throw new CheckoutGatewayError(
          'RETURN_INBOUND_REJECTED',
          'The warehouse did not confirm receipt of this return.',
          false,
          422,
        );
    },
    async refund(input) {
      const response = await exchange(
        environment.refundUrl,
        stringifyNumericJson({
          user_id: wireId(input.customerId),
          order_id: wireId(input.orderId),
          prod_id: wireId(input.productId),
          has_prod_id: wireId(input.lineId),
          is_pay_amt_in_tss_money: input.wallet,
          is_super_admin: input.superAdmin ? 1 : 0,
        }),
        { 'Content-Type': 'application/json', 'X-POS-Secret': environment.receiptSecret || '' },
        true,
      );
      // order/views.py:938-941: 400 "Already refunded" is a terminal answer, not an error.
      if (
        response.status === 400 &&
        z
          .object({ message: z.literal('Already refunded') })
          .passthrough()
          .safeParse(response.value).success
      )
        return { kind: 'already-refunded' };
      if (response.status !== 200)
        throw new CheckoutGatewayError(
          'RETURN_REFUND_FAILED',
          'Something went wrong while returning an order.',
          response.status >= 500,
          response.status < 500 ? 422 : 502,
        );
      const result = z
        .object({ return_amount: z.union([z.string(), z.number()]) })
        .passthrough()
        .parse(response.value);
      const amount = new Decimal(result.return_amount);
      if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 2)
        throw new CheckoutGatewayError(
          'RETURN_REFUND_AMOUNT_UNCONFIRMED',
          'The service returned an unsupported refund amount.',
          true,
        );
      return {
        kind: 'refunded',
        returnAmount: amount.toFixed(2),
        returnAmountRaw: result.return_amount,
      };
    },
    async returnMail(value) {
      const url = mailUrl('api/v2/mailr/omnichannel-return-order/');
      if (url)
        await notify(
          'return-mail',
          url,
          {
            order_id: wireId(value.orderId),
            product_ids: [wireId(value.productId)],
            store_id: wireId(value.storeId),
            has_product_ids: [wireId(value.lineId)],
          },
          10000,
        );
    },
    async exchangeMail(value) {
      const url = mailUrl('api/v2/mailr/exchange/');
      if (url)
        await notify(
          'exchange-mail',
          url,
          {
            order_id: wireId(value.orderId),
            product_id: wireId(value.productId),
            has_product_id: value.lineId === null ? null : wireId(value.lineId),
          },
          10000,
        );
    },
    async slack(value) {
      const message = value.staffUser
        ? `${value.message} | Staff User : ${value.staffUser}`
        : value.message;
      const target = value.storeSlackUrl || environment.slackUrl;
      const urls = [
        target,
        environment.commonGroupAlert && environment.slackUrl && target !== environment.slackUrl
          ? environment.slackUrl
          : undefined,
      ].filter((url): url is string => Boolean(url));
      for (const raw of urls) {
        let url: URL;
        try {
          url = endpoint(raw);
        } catch {
          continue;
        }
        await notify('exchange-alert', url, { text: message }, 5000);
      }
    },
  };
}
