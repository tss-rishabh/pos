import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { auditCrossStoreLookup } from '../../src/modules/order-history/audit.js';

describe('S24 cross-store lookup audit', () => {
  it('logs a registered resource event with identifiers only', () => {
    const info = vi.fn();
    const request = {
      id: 'request-1',
      principal: { id: '7' },
      log: { info },
    } as unknown as FastifyRequest;
    auditCrossStoreLookup(request, 'order-detail', { storeId: '2', orderId: '99' });
    const [event, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('Cross-store order lookup');
    expect(event).toMatchObject({
      eventId: 'orders.cross-store-lookup.read.completed',
      module: 'orders',
      resource: 'cross-store-lookup',
      requestId: 'request-1',
      userId: '7',
      lookup: 'order-detail',
      storeId: '2',
      orderId: '99',
    });
    expect(Object.keys(event).sort()).toEqual(
      [
        'eventId',
        'eventInstanceId',
        'module',
        'resource',
        'requestId',
        'userId',
        'lookup',
        'storeId',
        'orderId',
      ].sort(),
    );
  });
});
