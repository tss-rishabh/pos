import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RegisteredEvent } from '../../observability/event-registry.js';

/**
 * S24: a lookup of any store's order or invoice by order number (legacy `?cr=1` from an
 * explicit order-ID search) stays available because cross-store returns and exchanges need
 * it. It requires a session and is audited with a registered resource event that carries
 * only identifiers: no customer data, no request body and no search values.
 */
export type CrossStoreLookup = 'order-search' | 'order-detail' | 'invoice';
export function auditCrossStoreLookup(
  request: FastifyRequest,
  lookup: CrossStoreLookup,
  scope: { storeId: string; orderId?: string; orderCount?: number },
) {
  request.log.info(
    {
      eventId: 'orders.cross-store-lookup.read.completed',
      eventInstanceId: randomUUID(),
      module: 'orders',
      resource: 'cross-store-lookup',
      requestId: request.id,
      userId: request.principal?.id ?? null,
      lookup,
      storeId: scope.storeId,
      ...(scope.orderId ? { orderId: scope.orderId } : {}),
      ...(scope.orderCount !== undefined ? { orderCount: scope.orderCount } : {}),
    } satisfies RegisteredEvent,
    'Cross-store order lookup',
  );
}
