import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { fulfillmentMonitoring, monitorCounts } from '../../src/modules/fulfillment/monitoring.js';
import { monitoringOptions } from '../../src/modules/fulfillment/monitoring-options.js';
const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'monitoring-fixture-'.repeat(3),
  }),
  clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
const user: Principal = {
  id: '10',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
const options = monitoringOptions(
  Object.fromEntries(
    [
      'EXPRESS_LINES',
      'ORDERS',
      'HAS_PRODUCTS',
      'PRODUCTS',
      'STORES',
      'ORDER_STATUSES',
      'PAYMENT_STATUSES',
      'STATUS_LOGS',
    ].map((key) => [`BQ_FULFILLMENT_${key}`, `fixture-project.fulfillment.${key.toLowerCase()}`]),
  ),
);
describe('all-store monitoring reader safety', () => {
  it('keeps source summed per-status distinct counts instead of deduplicating across shipped statuses', () =>
    expect(
      monitorCounts([
        { status: 'OUT_FOR_DELIVERY', count: 2 },
        { status: 'DELIVERED', count: 2 },
        { status: 'RTO', count: 1 },
      ]).shipped,
    ).toBe(5));
  it('routes history only to bound warehouse queries and preserves large order identifiers', async () => {
    let databaseCalls = 0;
    const queries: { statement: string; params: Record<string, unknown> }[] = [];
    const db: Databases = {
      get: () => {
        databaseCalls++;
        throw new Error('Unexpected MySQL read');
      },
      close: async () => {},
    };
    const warehouse = {
      queryReport: async (statement: string, params: Record<string, unknown>) => {
        queries.push({ statement, params });
        if (statement.startsWith('SELECT e.status')) return [{ status: 'PENDING', count: 1 }];
        if (statement.startsWith('SELECT COUNT(*)')) return [{ count: 1 }];
        if (statement.startsWith('SELECT CAST(e.order_id'))
          return [{ orderId: '9007199254740993', storeId: '1', expiresAt: '2026-11-15 14:00:00' }];
        return [
          {
            id: '1',
            orderId: '9007199254740993',
            storeId: '1',
            hasProductId: '500',
            status: 'PENDING',
            pendingExpiresAt: '2026-11-15 14:00:00',
            acceptedExpiresAt: '2026-11-15 16:00:00',
            productId: '100',
            productName: 'Fixture tee',
            productStatus: 'CONFIRMED',
            quantity: '1',
            preGstAmount: 100,
            gst: 5,
            awb: null,
            shipmentId: null,
            vincStatus: '',
            updatedAt: '2026-11-15 12:00:00',
            price: '105',
            images: '{}',
            parentImages: null,
            parentProductId: '0',
            orderExists: '9007199254740993',
            reference: 'FIXTURE',
            userId: '10',
            firstName: 'Fixture',
            lastName: '',
            createdAt: '2026-11-15 12:00:00',
            paymentStatus: 'Paid',
            orderStatus: 'Confirmed',
            storeName: 'Fixture store',
          },
        ];
      },
    };
    const service = fulfillmentMonitoring(config, db, options, warehouse, clock),
      result = await service.read(user, {
        from: '2026-11-15',
        to: '2026-11-15',
        tab: 'in_queue',
        page: 1,
        pageSize: 25,
        orderIds: ['9007199254740993'],
      });
    expect(result.reader).toBe('bigquery');
    expect(result.data[0]?.orderId).toBe('9007199254740993');
    expect(databaseCalls).toBe(0);
    expect(queries).toHaveLength(4);
    expect(queries.every((query) => !query.statement.includes('9007199254740993'))).toBe(true);
    expect(queries[0]?.params.stores).toEqual(['1']);
    await expect(
      fulfillmentMonitoring(config, db, monitoringOptions({}), warehouse, clock).read(user, {
        from: '2026-11-15',
        to: '2026-11-15',
        tab: 'in_queue',
        page: 1,
        pageSize: 25,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(databaseCalls).toBe(0);
  });
});
