import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import type { EcommerceSynchronizationOptions } from './options.js';
import {
  fullSyncBody,
  fullSyncCommand,
  fullSyncContract,
  fullSyncHash,
  fullSyncResult,
  type FullSyncAdapter,
  type FullSyncCommand,
} from './domain.js';
const failed = () =>
  new AppError(
    503,
    'ECOMMERCE_FULL_SYNC_UNAVAILABLE',
    'Full ecommerce synchronization could not be verified.',
  );
export const fullSyncResponseSignature = (secret: string, id: string, body: string) =>
  createHmac('sha256', secret)
    .update(
      `${fullSyncContract}\nresponse\n${id}\n${createHash('sha256').update(body).digest('hex')}`,
    )
    .digest('hex');
export function createEcommerceFullSyncAdapter(
  options: EcommerceSynchronizationOptions,
  fetcher: typeof fetch = fetch,
  clock = () => Date.now(),
): FullSyncAdapter | undefined {
  if (
    !options.ECOMMERCE_FULL_SYNC_CONTRACT ||
    !options.ECOMMERCE_FULL_SYNC_URL ||
    !options.ECOMMERCE_FULL_SYNC_SECRET
  )
    return undefined;
  const base = new URL(options.ECOMMERCE_FULL_SYNC_URL),
    secret = options.ECOMMERCE_FULL_SYNC_SECRET;
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname.endsWith('/')
  )
    throw new AppError(
      503,
      'ECOMMERCE_FULL_SYNC_CONFIGURATION_INVALID',
      'Configure an exact private HTTPS full-sync resource.',
    );
  async function call(command: FullSyncCommand, method: 'GET' | 'POST', signal?: AbortSignal) {
    command = fullSyncCommand.parse(command);
    const body = method === 'POST' ? fullSyncBody(command) : '',
      url = method === 'POST' ? base : new URL(base.href + '/' + command.operationId),
      timestamp = String(Math.floor(clock() / 1000)),
      signature = createHmac('sha256', secret)
        .update(
          `${fullSyncContract}\n${timestamp}\n${method}\n${url.pathname}\n${createHash('sha256').update(body).digest('hex')}`,
        )
        .digest('hex');
    try {
      const response = await fetcher(url, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': command.operationId,
          'X-Ecom-Timestamp': timestamp,
          'X-Ecom-Signature': signature,
        },
        ...(method === 'POST' ? { body } : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(options.ECOMMERCE_FULL_SYNC_TIMEOUT_MS)])
          : AbortSignal.timeout(options.ECOMMERCE_FULL_SYNC_TIMEOUT_MS),
      });
      if (!response.headers.get('content-type')?.startsWith('application/json')) {
        await response.body?.cancel();
        throw failed();
      }
      const reader = response.body?.getReader();
      if (!reader) throw failed();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 16384) {
            await reader.cancel();
            throw failed();
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString('utf8'),
        supplied = response.headers.get('x-ecom-signature') || '',
        expected = fullSyncResponseSignature(secret, command.operationId, text);
      if (
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))
      )
        throw failed();
      const json: unknown = JSON.parse(text);
      if (response.status === 404 && method === 'GET') {
        const missing = z
          .object({
            contract: z.literal(fullSyncContract),
            operationId: z.literal(command.operationId),
            error: z.literal('ECOMMERCE_FULL_SYNC_NOT_FOUND'),
          })
          .strict();
        if (missing.safeParse(json).success) return null;
        throw failed();
      }
      if (response.status !== 200 && response.status !== 202) throw failed();
      const result = fullSyncResult.parse(json);
      if (
        result.operationId !== command.operationId ||
        result.requestHash !== fullSyncHash(command)
      )
        throw failed();
      return result;
    } catch {
      throw failed();
    }
  }
  return {
    async submit(command, signal) {
      const result = await call(command, 'POST', signal);
      if (!result) throw failed();
      return result;
    },
    read: (command, signal) => call(command, 'GET', signal),
  };
}
