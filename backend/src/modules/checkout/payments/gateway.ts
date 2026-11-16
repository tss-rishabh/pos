import PaytmChecksum from 'paytmchecksum';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import { boundedJson } from '../../../domain/http-json.js';
import { AppError } from '../../../domain/errors.js';
import { minorUnits } from '../../../domain/money.js';
import { stringifyNumericJson } from '../../upstream.js';
import { pineUploadPayload, pineStatusPayload, pineCancelPayload } from '../payloads.js';
import {
  paymentMode,
  type PaymentAttempt,
  type PaymentGateway,
  type Terminal,
  type ProviderDecision,
  type PaytmTerminal,
} from './contracts.js';

export interface PaymentEnvironment {
  pineBaseUrl?: string;
  paytmBaseUrl?: string;
  autoCancelMinutes: number;
}
export function paymentEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentEnvironment {
  const value = z
    .object({
      TSS_PINELABS_BASE_URL: z.url().optional(),
      TSS_PAYTM_BASE_URL: z.url().optional(),
      TSS_TERMINAL_AUTO_CANCEL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  return {
    pineBaseUrl: value.TSS_PINELABS_BASE_URL,
    paytmBaseUrl: value.TSS_PAYTM_BASE_URL,
    autoCancelMinutes: value.TSS_TERMINAL_AUTO_CANCEL_MINUTES,
  };
}
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(pythonJson).join(', ') + ']';
  if (typeof value === 'object' && value !== null)
    return (
      '{' +
      Object.entries(value)
        .map(([key, item]) => pythonJson(key) + ': ' + pythonJson(item))
        .join(', ') +
      '}'
    );
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
export function paytmBody(
  attempt: PaymentAttempt,
  terminal: PaytmTerminal,
  now: string,
  start: boolean,
) {
  return {
    paytmMid: terminal.mid,
    paytmTid: terminal.tid,
    transactionDateTime: now,
    merchantTransactionId: attempt.transactionId,
    ...(start
      ? {
          transactionAmount: minorUnits(attempt.onlineAmount).toString(),
          merchantExtendedInfo: { paymentMode: attempt.channel === 'paytm-card' ? 'CARD' : 'QR' },
        }
      : {}),
  };
}
export function paytmDecision(
  raw: unknown,
  attempt: PaymentAttempt,
  terminal: PaytmTerminal,
  start: boolean,
): ProviderDecision {
  const response = z
      .object({
        body: z
          .object({
            resultInfo: z.object({ resultCodeId: z.string() }),
            paytmMid: z.string().optional(),
            paytmTid: z.string().optional(),
            merchantTransactionId: z.string().optional(),
            transactionAmount: z.union([z.string(), z.number()]).optional(),
          })
          .passthrough(),
      })
      .parse(raw),
    body = response.body,
    code = body.resultInfo.resultCodeId;
  if (start)
    return {
      status:
        code === '0009' ? 'pending' : ['0002', '0007'].includes(code) ? 'failed' : 'uncertain',
      reference: attempt.transactionId,
      code,
    };
  if (code === '0000') {
    if (
      body.paytmMid !== terminal.mid ||
      body.paytmTid !== terminal.tid ||
      body.merchantTransactionId !== attempt.transactionId ||
      String(body.transactionAmount) !== minorUnits(attempt.onlineAmount).toString()
    )
      throw new AppError(
        502,
        'PAYMENT_EVIDENCE_MISMATCH',
        'The provider response did not match this payment.',
      );
    return { status: 'paid', reference: attempt.transactionId, code };
  }
  const matched =
    body.paytmMid === terminal.mid &&
    body.paytmTid === terminal.tid &&
    body.merchantTransactionId === attempt.transactionId &&
    String(body.transactionAmount) === minorUnits(attempt.onlineAmount).toString();
  return {
    status:
      code === '0011' && matched
        ? 'failed'
        : ['0009', '0010', '0030'].includes(code)
          ? 'pending'
          : 'uncertain',
    reference: attempt.transactionId,
    code,
  };
}
export function terminalGateway(
  config: Config,
  environment: PaymentEnvironment,
  fetcher: typeof fetch = fetch,
): PaymentGateway {
  function base(channel: string) {
    const raw = channel.startsWith('pine-') ? environment.pineBaseUrl : environment.paytmBaseUrl;
    if (!raw)
      throw new AppError(
        503,
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'This payment provider is not configured.',
      );
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Payment providers require HTTPS.');
    return raw.replace(/\/?$/, '/');
  }
  async function send(channel: string, path: string, payload: unknown): Promise<unknown> {
    const response = await fetcher(new URL(path, base(channel)), {
      method: 'POST',
      body: stringifyNumericJson(payload),
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new AppError(
        502,
        'PAYMENT_PROVIDER_UNCONFIRMED',
        'The payment provider did not confirm this action.',
      );
    return boundedJson(response);
  }
  async function paytm(attempt: PaymentAttempt, terminal: PaytmTerminal, start: boolean) {
    if (Buffer.byteLength(terminal.merchantKey) !== 16)
      throw new AppError(
        503,
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'This terminal has an invalid signing configuration.',
      );
    const now = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' '),
      body = paytmBody(attempt, terminal, now, start);
    const signature = start
      ? await PaytmChecksum.generateSignature(pythonJson(body), terminal.merchantKey)
      : await PaytmChecksum.generateSignature(
          Object.fromEntries(
            Object.entries(body).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
          terminal.merchantKey,
        );
    return paytmDecision(
      await send(attempt.channel, start ? 'payment/request' : 'payment/status', {
        head: {
          requestTimeStamp: now,
          channelId: terminal.channelId,
          checksum: signature,
          version: '3.1',
        },
        body,
      }),
      attempt,
      terminal,
      start,
    );
  }
  async function pine(
    attempt: PaymentAttempt,
    terminal: Terminal,
    action: 'start' | 'status' | 'cancel',
  ): Promise<ProviderDecision> {
    if (terminal.provider !== 'pine')
      throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Incorrect terminal provider.');
    if (action !== 'start' && !attempt.providerReference)
      throw new AppError(
        409,
        'PAYMENT_REFERENCE_UNAVAILABLE',
        'The provider did not return a reference. Review the terminal before taking another payment.',
      );
    const path =
        action === 'start'
          ? 'V1/UploadBilledTransaction'
          : action === 'status'
            ? 'V1/GetCloudBasedTxnStatus'
            : 'V1/CancelTransactionForced',
      payload =
        action === 'start'
          ? pineUploadPayload(
              terminal,
              attempt.transactionId,
              attempt.onlineAmount,
              paymentMode(attempt.channel),
              attempt.operatorId,
              environment.autoCancelMinutes,
            )
          : action === 'status'
            ? pineStatusPayload(terminal, attempt.providerReference!)
            : pineCancelPayload(terminal, attempt.providerReference!, attempt.onlineAmount, true);
    const response = z
      .object({
        ResponseCode: z.number().int().optional(),
        ResponseMessage: z.string(),
        PlutusTransactionReferenceID: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .parse(await send(attempt.channel, path, payload));
    const reference =
        response.PlutusTransactionReferenceID === undefined
          ? attempt.providerReference
          : String(response.PlutusTransactionReferenceID),
      code = response.ResponseMessage;
    if (action !== 'start' && reference !== attempt.providerReference)
      throw new AppError(
        502,
        'PAYMENT_EVIDENCE_MISMATCH',
        'The provider response did not match this terminal payment.',
      );
    if (action === 'start')
      return {
        status:
          response.ResponseCode === 0 && code === 'APPROVED' && reference ? 'pending' : 'uncertain',
        reference,
        code,
      };
    if (action === 'cancel')
      return {
        status: response.ResponseCode === 0 && code === 'APPROVED' ? 'cancelled' : 'uncertain',
        reference,
        code,
      };
    return {
      status:
        response.ResponseCode === 0 && code === 'TXN APPROVED'
          ? 'paid'
          : code === 'TXN UPLOADED'
            ? 'pending'
            : 'uncertain',
      reference,
      code,
    };
  }
  return {
    configured(channel) {
      if (channel.startsWith('pine-') || channel.startsWith('paytm-')) base(channel);
    },
    start(attempt, terminal) {
      return terminal.provider === 'paytm'
        ? paytm(attempt, terminal, true)
        : pine(attempt, terminal, 'start');
    },
    status(attempt, terminal) {
      return terminal.provider === 'paytm'
        ? paytm(attempt, terminal, false)
        : pine(attempt, terminal, 'status');
    },
    cancel(attempt, terminal) {
      if (terminal.provider === 'paytm')
        throw new AppError(
          503,
          'PAYTM_CANCELLATION_UNCONFIRMED',
          'Cancel or void this transaction on the terminal, then reconcile its provider status.',
        );
      return pine(attempt, terminal, 'cancel');
    },
  };
}
