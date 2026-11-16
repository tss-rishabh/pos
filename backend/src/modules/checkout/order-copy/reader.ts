import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gte } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { HasProduct, Order, OrderStore } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { copyFactsSchema, type CopyFactsPort } from './contracts.js';

export function copyCutoff(config: Pick<Config, 'BUSINESS_TIMEZONE'>, now: number): string {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
    .startOfDay()
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
}
/** Historical facts are an injected qualified warehouse reader, never a MySQL fallback. */
export function orderCopyFacts(
  db: Databases,
  history?: CopyFactsPort,
  clock = Date.now,
): CopyFactsPort {
  return {
    async read(input) {
      const database = db.get('primary');
      const [order] = await database
        .select({ id: Order.id, customerId: Order.user, createdAt: Order.created_at })
        .from(Order)
        .where(and(eq(Order.id, BigInt(input.source.orderId)), gte(Order.created_at, input.cutoff)))
        .limit(1);
      if (!order) {
        if (!history)
          throw new AppError(
            503,
            'ORDER_COPY_HISTORY_UNAVAILABLE',
            'Historical order copying requires the qualified warehouse reader.',
          );
        const historical = copyFactsSchema.parse(await history.read(input));
        if (historical.reader !== 'bigquery' || historical.createdAt >= input.cutoff)
          throw new AppError(
            503,
            'ORDER_COPY_HISTORY_INVALID',
            'Historical product facts do not match the warehouse scope.',
          );
        return historical;
      }
      const mappings = await database
        .select({ storeId: OrderStore.store })
        .from(OrderStore)
        .where(eq(OrderStore.order, order.id))
        .orderBy(asc(OrderStore.id))
        .limit(2);
      if (
        input.source.kind === 'store' &&
        (mappings.length !== 1 || String(mappings[0]!.storeId) !== input.source.storeId)
      )
        throw new AppError(
          404,
          'ORDER_COPY_SOURCE_NOT_FOUND',
          'The source order is not available in this scope.',
        );
      if (input.source.kind === 'customer' && String(order.customerId) !== input.targetCustomerId)
        throw new AppError(
          404,
          'ORDER_COPY_SOURCE_NOT_FOUND',
          'The source order is not available in this scope.',
        );
      const lines = await database
        .select({ lineId: HasProduct.id, productId: HasProduct.product })
        .from(HasProduct)
        .where(eq(HasProduct.order, order.id))
        .orderBy(asc(HasProduct.id))
        .limit(501);
      return copyFactsSchema.parse({
        orderId: String(order.id),
        sourceCustomerId: String(order.customerId),
        sourceStoreId: mappings.length === 1 ? String(mappings[0]!.storeId) : null,
        createdAt: order.createdAt,
        reader: 'primary',
        fetchedAt: new Date(clock()).toISOString(),
        generationId: 'current-primary',
        complete: true,
        lines: lines.map((line) => ({
          lineId: String(line.lineId),
          productId: String(line.productId),
        })),
      });
    },
  };
}
