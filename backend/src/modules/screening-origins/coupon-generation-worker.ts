import { randomUUID } from 'node:crypto';
import { originError } from './contracts.js';
import { originHistoryKeys } from './history-contracts.js';
import { originCouponGenericScope, type originCouponDemandJournal } from './coupon-demands.js';
import type { couponGenerationPublisher } from '../legacy-order-imports/benefit-profile/history-generation-publisher.js';
import {
  verifyGenerationControl,
  type GenerationControlDescriptor,
} from '../legacy-order-imports/benefit-profile/history-generation-control.js';
export interface OriginCouponControlsPort {
  read(couponId: string, signal: AbortSignal): Promise<GenerationControlDescriptor>;
}
/** Explicit ID-scoped GET-only current controls. No historical/native fallback,
 * bearer capability, original financial call or constructor network I/O. */
export function originCouponControlsHttp(
  options: { url: string; key: string; sourceKey: string; timeoutMs?: number },
  dependencies: { fetcher?: typeof fetch; clock?: () => number } = {},
): OriginCouponControlsPort {
  const url = new URL(options.url),
    timeout = options.timeoutMs ?? 8000;
  originHistoryKeys(options.key, options.sourceKey);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/internal/screening-origins/coupons/controls/' ||
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > 25000
  )
    throw originError('SCREENING_ORIGIN_COUPON_CONTROLS_CONFIGURATION');
  const fetcher = dependencies.fetcher ?? fetch,
    clock = dependencies.clock ?? Date.now;
  return {
    async read(couponId, signal) {
      if (!/^[1-9][0-9]{0,9}$/.test(couponId) || BigInt(couponId) > 2147483647n)
        throw originError('SCREENING_ORIGIN_COUPON_CONTROLS_INVALID');
      const controller = new AbortController(),
        combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(timeout)]);
      try {
        combined.throwIfAborted();
        const response = await fetcher(new URL(couponId, url), {
          method: 'GET',
          redirect: 'error',
          signal: combined,
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-store',
            'X-POS-Origin-Coupon-Controls-Key': options.key,
            'X-Request-ID': randomUUID(),
          },
        });
        if (!response.ok || !response.body) throw originError();
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const next = await reader.read();
            combined.throwIfAborted();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > 16000) throw originError();
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const result = verifyGenerationControl(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          options.sourceKey,
          clock(),
        );
        if (result.data.couponId !== couponId) throw originError();
        combined.throwIfAborted();
        return result;
      } catch {
        controller.abort();
        throw originError('SCREENING_ORIGIN_COUPON_CONTROLS_UNAVAILABLE');
      }
    },
  };
}
/** Only readonly source preparation may repeat after lease loss. Successful
 * native generation/demand bind is atomic; then the existing publisher worker
 * owns its immutable original write jobs and GET-only unknown recovery. */
export function originCouponGenerationWorker(dependencies: {
  demands: ReturnType<typeof originCouponDemandJournal>;
  publisher: ReturnType<typeof couponGenerationPublisher>;
  controls: OriginCouponControlsPort;
  enabled: () => boolean;
}) {
  let running: Promise<{ claimed: number; prepared: number; unavailable: number }> | undefined;
  return {
    drain(signal: AbortSignal, limit = 2) {
      if (running) return running;
      running = (async () => {
        const summary = { claimed: 0, prepared: 0, unavailable: 0 };
        if (!dependencies.enabled() || signal.aborted) return summary;
        for (const id of await dependencies.demands.due(limit)) {
          if (!dependencies.enabled() || signal.aborted) break;
          const row = await dependencies.demands.claim(id);
          if (!row || !row.lease) continue;
          summary.claimed++;
          const lease = row.lease;
          try {
            const control = await dependencies.controls.read(
                row.request.selection.couponId,
                signal,
              ),
              scope = originCouponGenericScope(row.request),
              d = control.data;
            if (
              d.couponId !== scope.couponId ||
              d.configurationHash !== scope.configurationHash ||
              d.sourceDay !== scope.sourceDay ||
              d.sourceTimeZone !== scope.sourceTimeZone ||
              d.serverUuid !== row.request.witness.serverUuid ||
              d.sourceSchema !== row.request.witness.sourceSchema ||
              JSON.stringify(d.heads) !== JSON.stringify(row.request.witness.heads.slice(0, 2))
            ) {
              await dependencies.demands.reschedule(id, lease, true);
              continue;
            }
            signal.throwIfAborted();
            if (!dependencies.enabled()) throw originError();
            await dependencies.publisher.prepare(
              scope,
              control,
              async (tx, generation) => {
                signal.throwIfAborted();
                if (!dependencies.enabled()) throw originError();
                await dependencies.demands.bind(tx, id, lease, generation);
              },
              signal,
            );
            summary.prepared++;
          } catch (error) {
            summary.unavailable++;
            const superseded =
              error instanceof Error &&
              'code' in error &&
              error.code === 'SCREENING_ORIGIN_COUPON_GENERATION_SUPERSEDED';
            await dependencies.demands.reschedule(id, lease, superseded);
          }
        }
        return summary;
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
