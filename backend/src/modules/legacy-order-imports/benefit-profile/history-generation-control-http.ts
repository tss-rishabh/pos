import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  generationControlContract,
  verifyGenerationControl,
  type GenerationControlPort,
} from './history-generation-control.js';
import { generationError } from './history-generation-contracts.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
const optionsSchema = z
  .object({
    contract: z.literal(generationControlContract).optional(),
    url: z.url().optional(),
    key: z.string().optional(),
    timeoutMs: z.number().int().min(100).max(10000).default(5000),
  })
  .strict();
export type GenerationControlHttpOptions = z.infer<typeof optionsSchema>;
/** Background publisher only. The runtime history reader never imports this
 * resource. No default URL/key/credential or request-triggered refresh exists. */
export function generationControlHttp(
  supplied: GenerationControlHttpOptions,
  authority: { sourceKey: string; separateFrom?: readonly string[] },
  dependencies: { fetcher?: typeof fetch; clock?: () => number } = {},
): GenerationControlPort {
  const parsed = optionsSchema.safeParse(supplied);
  if (!parsed.success) throw generationError('CONTROL_REQUIRED', 503);
  const options = Object.freeze(parsed.data),
    clock = dependencies.clock ?? Date.now,
    fetcher = dependencies.fetcher ?? fetch;
  return {
    async read(signal) {
      if (
        options.contract !== generationControlContract ||
        !options.url ||
        !options.key ||
        signal.aborted
      )
        throw generationError('CONTROL_REQUIRED', 503);
      couponWarehouseKeys(options.key, authority.sourceKey);
      if (authority.separateFrom?.includes(options.key))
        throw generationError('CONTROL_REQUIRED', 503);
      const url = new URL(options.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/internal/pos/coupon-history/controls/current'
      )
        throw generationError('CONTROL_REQUIRED', 503);
      const controller = new AbortController(),
        combined = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        abort = () => {
          controller.abort();
          reject(generationError('CONTROL_UNAVAILABLE', 503));
        };
        timer = setTimeout(abort, options.timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        return await Promise.race([
          deadline,
          (async () => {
            const response = await fetcher(url, {
              method: 'GET',
              redirect: 'error',
              signal: combined,
              headers: {
                'X-POS-Coupon-History-Controls-Key': options.key!,
                'X-Request-ID': randomUUID(),
                Accept: 'application/json',
              },
            });
            if (response.status !== 200 || !response.body) {
              void response.body?.cancel().catch(() => undefined);
              throw generationError('CONTROL_UNAVAILABLE', 503);
            }
            const reader = response.body.getReader(),
              chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              while (true) {
                combined.throwIfAborted();
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 16000) throw generationError('CONTROL_UNAVAILABLE', 503);
                chunks.push(chunk.value);
              }
            } catch (error) {
              void reader.cancel().catch(() => undefined);
              throw error;
            } finally {
              reader.releaseLock();
            }
            combined.throwIfAborted();
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            return verifyGenerationControl(value, authority.sourceKey, clock());
          })(),
        ]);
      } catch {
        controller.abort();
        throw generationError('CONTROL_UNAVAILABLE', 503);
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
      }
    },
  };
}
/** Root may map these into its shared config; no environment value is logged. */
export function readGenerationControlHttpOptions(
  env: NodeJS.ProcessEnv = process.env,
): GenerationControlHttpOptions {
  const parsed = optionsSchema.safeParse({
    contract: env.CSV_COUPON_GENERATION_CONTROLS_CONTRACT || undefined,
    url: env.CSV_COUPON_GENERATION_CONTROLS_URL || undefined,
    key: env.CSV_COUPON_GENERATION_CONTROLS_KEY || undefined,
    timeoutMs: env.CSV_COUPON_GENERATION_CONTROLS_TIMEOUT_MS
      ? Number(env.CSV_COUPON_GENERATION_CONTROLS_TIMEOUT_MS)
      : undefined,
  });
  if (!parsed.success) throw generationError('CONTROL_REQUIRED', 503);
  return parsed.data;
}
