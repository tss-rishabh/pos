import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  ipcChannels,
  ipcEnvelopeSchema,
  ipcRequestSchemas,
  type IpcChannel,
  type IpcParsedRequest,
  type IpcReply,
} from '../../src/offline/billing/contracts';
import { OfflineBillingError, type OfflineLogEvent } from './service';

/** Minimal ipcMain surface so the handlers can be tested without Electron. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}
export type IpcHandlers = {
  [C in IpcChannel]: (payload: IpcParsedRequest<C>, traceId: string) => Promise<unknown> | unknown;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate and dispatch one IPC call. The renderer-supplied requestId becomes
 * the traceId when it is a valid UUID; otherwise a new one is generated. Logs
 * carry only the channel, outcome, error code/class name and timing — never
 * payload values or error messages. */
export async function dispatchIpc(
  channel: IpcChannel,
  raw: unknown,
  handlers: IpcHandlers,
  log: (event: OfflineLogEvent & { channel: string }) => void,
  now: () => number = () => performance.now(),
): Promise<IpcReply> {
  const started = now();
  const envelope = ipcEnvelopeSchema.safeParse(raw);
  const requestId =
    envelope.success && uuid.test(envelope.data.requestId) ? envelope.data.requestId : randomUUID();
  const finish = (reply: IpcReply, errorCode?: string, errorName?: string): IpcReply => {
    log({
      eventId: 'offline.ipc.completed',
      channel,
      traceId: requestId,
      outcome: reply.ok ? 'succeeded' : 'failed',
      ...(errorCode ? { errorCode } : {}),
      ...(errorName ? { errorName } : {}),
      durationMs: Math.round(now() - started),
    });
    return reply;
  };
  if (!envelope.success)
    return finish(
      {
        ok: false,
        requestId,
        error: { code: 'INVALID_REQUEST', message: 'The request was malformed.' },
      },
      'INVALID_REQUEST',
    );
  try {
    const payload = ipcRequestSchemas[channel].parse(envelope.data.payload);
    const handler = handlers[channel] as (value: typeof payload, traceId: string) => unknown;
    const data = await handler(payload, requestId);
    return finish({ ok: true, requestId, data });
  } catch (error) {
    if (error instanceof ZodError)
      return finish(
        {
          ok: false,
          requestId,
          error: { code: 'INVALID_REQUEST', message: 'Check the entered details.' },
        },
        'INVALID_REQUEST',
      );
    if (error instanceof OfflineBillingError)
      return finish(
        { ok: false, requestId, error: { code: error.code, message: error.message } },
        error.code,
      );
    return finish(
      {
        ok: false,
        requestId,
        error: {
          code: 'OFFLINE_BILLING_FAILED',
          message: 'Offline billing could not complete this request.',
        },
      },
      'OFFLINE_BILLING_FAILED',
      error instanceof Error ? error.name : 'NonErrorValue',
    );
  }
}

export function registerOfflineIpc(
  ipc: IpcMainLike,
  handlers: IpcHandlers,
  trustedSender: (event: unknown) => boolean,
  log: (event: OfflineLogEvent & { channel: string }) => void,
): () => void {
  for (const channel of ipcChannels)
    ipc.handle(channel, async (event, raw) => {
      if (!trustedSender(event)) {
        const requestId = randomUUID();
        log({
          eventId: 'offline.ipc.rejected',
          channel,
          traceId: requestId,
          outcome: 'failed',
          errorCode: 'UNTRUSTED_SENDER',
        });
        return {
          ok: false,
          requestId,
          error: { code: 'UNTRUSTED_SENDER', message: 'This window cannot use offline billing.' },
        } satisfies IpcReply;
      }
      return dispatchIpc(channel, raw, handlers, log);
    });
  return () => {
    for (const channel of ipcChannels) ipc.removeHandler(channel);
  };
}
