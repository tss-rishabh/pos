import PaytmChecksum from 'paytmchecksum';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { boundedJson } from '../../../domain/http-json.js';
import { AppError } from '../../../domain/errors.js';
import { minorUnits } from '../../../domain/money.js';
import { stringifyNumericJson } from '../../upstream.js';
import { pineUploadPayload, pineStatusPayload, pineCancelPayload } from '../payloads.js';
import {
  PaymentOutcomeUnknown,
  type PaymentGateway,
  type PaytmReply,
  type PaytmTerminal,
  type PineReply,
} from './contracts.js';
import { pythonRepr } from './legacy.js';

export interface PaymentEnvironment {
  pineBaseUrl?: string;
  paytmBaseUrl?: string;
  autoCancelMinutes: number;
}
/** Legacy names (POSAdmin/settings.py:458-467) are accepted when the rewrite names are blank. */
export function paymentEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentEnvironment {
  const value = z
    .object({
      TSS_PINELABS_BASE_URL: z.url().optional(),
      PINELAB_URL: z.url().optional(),
      TSS_PAYTM_BASE_URL: z.url().optional(),
      PAYTM_PROD_URL: z.url().optional(),
      TSS_TERMINAL_AUTO_CANCEL_MINUTES: z.coerce.number().int().min(1).max(60).optional(),
      AUTO_CANCEL_DURATION_IN_MINUTES: z.coerce.number().int().min(1).max(60).optional(),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, item]) => item !== '')));
  return {
    pineBaseUrl: value.TSS_PINELABS_BASE_URL ?? value.PINELAB_URL,
    paytmBaseUrl: value.TSS_PAYTM_BASE_URL ?? value.PAYTM_PROD_URL,
    autoCancelMinutes:
      value.TSS_TERMINAL_AUTO_CANCEL_MINUTES ?? value.AUTO_CANCEL_DURATION_IN_MINUTES ?? 5,
  };
}
/** Python `json.dumps` text (", " and ": " separators, ASCII escapes) used for the Paytm checksum. */
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
    /[\u007f-￿]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
/** Paytm request/status body (terminal_helpers.py:368-375, 455-459). */
export function paytmBody(
  terminal: PaytmTerminal,
  transactionId: string,
  now: string,
  start?: { onlineAmount: string; mode: 'CARD' | 'QR' },
) {
  return {
    paytmMid: terminal.mid,
    ...(start ? { paytmTid: terminal.tid } : {}),
    transactionDateTime: now,
    merchantTransactionId: transactionId,
    ...(start
      ? {
          transactionAmount: minorUnits(start.onlineAmount).toString(),
          merchantExtendedInfo: { paymentMode: start.mode },
        }
      : {}),
  };
}
const pineReplySchema = z
  .object({
    ResponseCode: z.number().int().optional(),
    ResponseMessage: z.string(),
    PlutusTransactionReferenceID: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();
export function pineReply(raw: unknown): PineReply {
  const parsed = pineReplySchema.safeParse(raw);
  if (!parsed.success) throw new PaymentOutcomeUnknown('unreadable');
  const reference = parsed.data.PlutusTransactionReferenceID;
  return {
    responseCode: parsed.data.ResponseCode ?? null,
    responseMessage: parsed.data.ResponseMessage,
    plutusId: reference === undefined || reference === null ? null : String(reference),
    apiResponse: pythonRepr(raw),
  };
}
const paytmReplySchema = z
  .object({
    body: z
      .object({
        resultInfo: z
          .object({ resultCodeId: z.string(), resultMsg: z.string().optional() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
export function paytmReply(raw: unknown): PaytmReply {
  const parsed = paytmReplySchema.safeParse(raw);
  if (!parsed.success) throw new PaymentOutcomeUnknown('unreadable');
  return {
    resultCode: parsed.data.body.resultInfo.resultCodeId,
    resultMessage: parsed.data.body.resultInfo.resultMsg ?? '',
    apiResponse: pythonRepr(raw),
  };
}

export function terminalGateway(
  config: Config,
  environment: PaymentEnvironment,
  fetcher: typeof fetch = fetch,
): PaymentGateway {
  function base(provider: 'pine' | 'paytm') {
    const raw = provider === 'pine' ? environment.pineBaseUrl : environment.paytmBaseUrl;
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
  /** Legacy timeout is 30 s (terminal_helpers.py:51). A 5xx or missing reply is unknown. */
  async function send(provider: 'pine' | 'paytm', path: string, payload: unknown) {
    const url = new URL(path, base(provider));
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        body: stringifyNumericJson(payload),
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new PaymentOutcomeUnknown(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport',
      );
    }
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PaymentOutcomeUnknown('http');
    }
    try {
      return await boundedJson(response);
    } catch {
      throw new PaymentOutcomeUnknown('unreadable');
    }
  }
  const rejected = (): PineReply => ({
    responseCode: null,
    responseMessage: 'Failed',
    plutusId: null,
    apiResponse: '',
  });
  async function paytm(
    terminal: PaytmTerminal,
    path: string,
    body: Record<string, unknown>,
    now: string,
    start: boolean,
  ) {
    if (Buffer.byteLength(terminal.merchantKey) !== 16)
      throw new AppError(
        409,
        'PAYMENT_MACHINE_UNAVAILABLE',
        'This terminal has an invalid signing configuration.',
      );
    // Legacy signs json.dumps(body) for a request and the dict (string values) for a status.
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
    const raw = await send('paytm', path, {
      head: {
        requestTimeStamp: now,
        channelId: terminal.channelId,
        checksum: signature,
        version: '3.1',
      },
      body,
    });
    if (raw === null) return { resultCode: 'HTTP', resultMessage: 'Failed', apiResponse: '' };
    return paytmReply(raw);
  }
  return {
    configured(provider) {
      base(provider);
    },
    async pineUpload(terminal, transactionId, onlineAmount, paymentMode, operatorId) {
      const raw = await send(
        'pine',
        'V1/UploadBilledTransaction',
        pineUploadPayload(
          terminal,
          transactionId,
          onlineAmount,
          paymentMode,
          operatorId,
          environment.autoCancelMinutes,
        ),
      );
      if (raw === null) return rejected();
      const reply = pineReply(raw);
      // Legacy reads PlutusTransactionReferenceID first; an approval without it is unusable.
      if (reply.responseCode === 0 && reply.responseMessage === 'APPROVED' && !reply.plutusId)
        throw new PaymentOutcomeUnknown('unreadable');
      return reply;
    },
    async pineStatus(terminal, plutusId) {
      const raw = await send(
        'pine',
        'V1/GetCloudBasedTxnStatus',
        pineStatusPayload(terminal, plutusId),
      );
      return raw === null ? rejected() : pineReply(raw);
    },
    async pineCancel(terminal, plutusId, onlineAmount) {
      const raw = await send(
        'pine',
        'V1/CancelTransactionForced',
        pineCancelPayload(terminal, plutusId, onlineAmount, true),
      );
      return raw === null ? rejected() : pineReply(raw);
    },
    paytmRequest(terminal, transactionId, onlineAmount, mode, now) {
      return paytm(
        terminal,
        'payment/request',
        paytmBody(terminal, transactionId, now, { onlineAmount, mode }),
        now,
        true,
      );
    },
    paytmStatus(terminal, transactionId, now) {
      return paytm(terminal, 'payment/status', paytmBody(terminal, transactionId, now), now, false);
    },
  };
}
