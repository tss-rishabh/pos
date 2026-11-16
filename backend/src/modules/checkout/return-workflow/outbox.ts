import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import { stringifyNumericJson } from '../../upstream.js';
import { wireId } from '../payloads.js';
import { returnOutbox } from './schema.js';
import type { DeliveryObserver } from '../delivery.js';
export function returnDeliveryEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return z.object({ TSS_RETURN_EMAIL_URL: z.url(), TSS_EXCHANGE_EMAIL_URL: z.url() }).parse(env);
}
export function returnOutboxDispatcher(
  db: Databases,
  config: Config,
  environment: ReturnType<typeof returnDeliveryEnvironment>,
  fetcher: typeof fetch = fetch,
  observe?: DeliveryObserver,
) {
  const urls = {
    returns: new URL(environment.TSS_RETURN_EMAIL_URL),
    exchange: new URL(environment.TSS_EXCHANGE_EMAIL_URL),
  };
  for (const url of Object.values(urls))
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new AppError(
        503,
        'RETURN_DELIVERY_UNAVAILABLE',
        'Return notification delivery is unavailable.',
      );
  return async function dispatch(limit = 10) {
    const count = z.number().int().min(1).max(100).parse(limit),
      summary = { delivered: 0, rejected: 0, uncertain: 0 };
    for (let index = 0; index < count; index++) {
      const job = await db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(returnOutbox)
          .where(
            and(
              eq(returnOutbox.status, 'pending'),
              inArray(returnOutbox.kind, ['return-email', 'exchange-email']),
            ),
          )
          .orderBy(asc(returnOutbox.createdAt), asc(returnOutbox.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        await tx
          .update(returnOutbox)
          .set({ status: 'processing' })
          .where(eq(returnOutbox.id, row.id));
        return row;
      });
      if (!job) break;
      let status: 'delivered' | 'rejected' | 'uncertain' = 'uncertain';
      try {
        const exchange = job.kind === 'exchange-email',
          response = await fetcher(exchange ? urls.exchange : urls.returns, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': job.id },
            body: stringifyNumericJson(
              exchange
                ? {
                    order_id: wireId(job.orderId),
                    product_id: wireId(job.productId),
                    has_product_id: wireId(job.lineId),
                  }
                : {
                    order_id: wireId(job.orderId),
                    product_ids: [wireId(job.productId)],
                    store_id: wireId(job.storeId),
                    has_product_ids: [wireId(job.lineId)],
                  },
            ),
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          });
        status = response.ok
          ? 'delivered'
          : response.status >= 400 && response.status < 500
            ? 'rejected'
            : 'uncertain';
        await response.body?.cancel();
      } catch {
        /* A notification with an unknown result needs explicit reconciliation. */
      }
      await db
        .get('writer')
        .update(returnOutbox)
        .set({ status })
        .where(and(eq(returnOutbox.id, job.id), eq(returnOutbox.status, 'processing')));
      summary[status]++;
      observe?.({
        id: job.id,
        resource: job.kind === 'exchange-email' ? 'exchange-email' : 'return-email',
        outcome: status,
        requestId: job.requestId,
        operatorId: job.operatorId,
      });
    }
    return summary;
  };
}
