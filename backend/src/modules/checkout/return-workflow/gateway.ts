import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import { stringifyNumericJson } from '../../upstream.js';
import { wireId } from '../payloads.js';
import { CheckoutGatewayError } from '../gateway.js';
import type { InboundReturn, ReturnGateway } from './contracts.js';
export interface ReturnEnvironment {
  eligibilityUrl?: string;
  vinculumUrl?: string;
  vinculumOwner?: string;
  vinculumKey?: string;
  transporterCode?: string;
  refundUrl?: string;
  receiptSecret?: string;
  returnPeriodDays?: number;
}
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
export function returnGateway(
  config: Config,
  environment: ReturnEnvironment,
  fetcher: typeof fetch = fetch,
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
  async function send(
    url: string | undefined,
    body: string,
    headers: Record<string, string>,
    sideEffect: boolean,
  ) {
    let response: Response;
    try {
      response = await fetcher(endpoint(url), {
        method: 'POST',
        body,
        headers,
        signal: AbortSignal.timeout(10000),
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
    if (!response.ok)
      throw new CheckoutGatewayError(
        'RETURN_DEPENDENCY_REJECTED',
        'The return service did not accept this action.',
        sideEffect && response.status >= 500,
        response.status < 500 ? 422 : 502,
      );
    return value;
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
    async sendOtp(_customerId) {
      throw new AppError(503,'CUSTOMER_VERIFICATION_SERVICE_UNAVAILABLE','Customer verification requires the local purpose-bound delivery service.');
    },
    async verifyOtp(_customerId, _otp) {
      throw new AppError(503,'CUSTOMER_VERIFICATION_SERVICE_UNAVAILABLE','Customer verification requires the local purpose-bound delivery service.');
    },
    async eligibility(orderId, storeId, lineId, token, kind = 'return') {
      const result = z
        .object({
          orders: z.array(
            z
              .object({
                products: z.array(
                  z
                    .object({
                      has_product_id: z.union([z.string(), z.number()]),
                      is_applicable_for_return: z.number().optional(),
                      is_applicable_for_exchange: z.number().optional(),
                      estimate_return_date: z.string().nullish(),
                      estimate_exchange_date: z.string().nullish(),
                    })
                    .passthrough(),
                ),
              })
              .passthrough(),
          ),
        })
        .parse(
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
      const line = result.orders
        .flatMap((order) => order.products)
        .find((line) => String(line.has_product_id) === lineId);
      if (!line)
        throw new AppError(
          409,
          'RETURN_ELIGIBILITY_UNAVAILABLE',
          'Return eligibility was not provided for this line.',
        );
      return {
        allowed:
          (kind === 'exchange'
            ? line.is_applicable_for_exchange
            : line.is_applicable_for_return) === 1,
        until:
          (kind === 'exchange' ? line.estimate_exchange_date : line.estimate_return_date) || null,
      };
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
      const result = z.object({ return_amount: z.union([z.string(), z.number()]) }).parse(
        await send(
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
        ),
      );
      const amount = new Decimal(result.return_amount);
      if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 2)
        throw new CheckoutGatewayError(
          'RETURN_REFUND_AMOUNT_UNCONFIRMED',
          'The service returned an unsupported refund amount.',
          true,
        );
      return { returnAmount: amount.toFixed(2) };
    },
  };
}
