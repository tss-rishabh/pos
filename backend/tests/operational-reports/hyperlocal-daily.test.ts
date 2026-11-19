import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  hyperlocalDailyCsv,
  hyperlocalDailyInputSchema,
  hyperlocalDailyOptions,
  hyperlocalDailyReportService,
  hyperlocalDailyScope,
  type HyperlocalDailyRow,
} from '../../src/modules/operational-reports/hyperlocal-daily.js';
const user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  },
  config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'hyperlocal-daily-fixture-'.repeat(3),
  }),
  clock = () => Temporal.Instant.from('2026-11-17T08:00:00Z'),
  input = hyperlocalDailyInputSchema.parse({
    from: '2026-11-16T00:00:00',
    to: '2026-11-16T23:59:59',
  }),
  record: HyperlocalDailyRow = {
    order_id: '1001',
    user_id: '1',
    line_item_id: '12',
    sku_id: '22',
    customer_name: 'Fixture Customer',
    qty: 4,
    amount: 236,
    order_status: 'Fixture delivered',
    line_item_status: 'DELIVERED',
    express_line_item_status: 'PACKED',
    order_date: '2026-11-15 10:00:00',
    location_code: 'FIX-1',
    store_name: 'Fixture store',
    allocation_date: '2026-11-14 09:00:00',
    pack_date: null,
    pickup_date: null,
    delivery_date: null,
  };
describe('hyperlocal daily warehouse and privacy contracts', () => {
  it('binds expiry range, preserves grouped quantities and masks restricted names before API/CSV', async () => {
    let mysqlReads = 0;
    const calls: { statement: string; params: Record<string, unknown>; resource?: string }[] = [],
      db: Databases = {
        get() {
          mysqlReads++;
          throw new Error('Historical MySQL forbidden');
        },
        close: async () => {},
      },
      warehouse = {
        async queryReport(
          statement: string,
          params: Record<string, unknown>,
          _types: Record<string, string | string[]>,
          resource?: string,
        ) {
          calls.push({ statement, params, resource });
          return statement.includes(' AS count') ? [{ count: 1 }] : [record];
        },
      },
      service = hyperlocalDailyReportService(
        config,
        db,
        hyperlocalDailyOptions({
          BQ_HYPERLOCAL_DAILY_VIEW: 'fixture-project.reports.hyperlocal_daily',
        }),
        warehouse,
        clock,
      ),
      result = await service.read({ ...user, userType: 2 }, input);
    expect(result.reader).toBe('bigquery');
    expect(result.data[0]?.customer_name).toBe('F**************r');
    expect(mysqlReads).toBe(0);
    expect(calls[0]?.params).toMatchObject({
      start: '2026-11-16 00:00:00',
      end: '2026-11-16 23:59:59',
      stores: ['1'],
      allStores: false,
    });
    expect(calls.every((call) => call.resource === 'hyperlocal-daily')).toBe(true);
    expect(calls[0]?.statement).toContain('pending_expires_at>=@start');
    expect(calls[1]?.statement).toContain('SUM(quantity)');
    const csv = hyperlocalDailyCsv(result.data);
    expect(csv).toContain('"236.0"');
    expect(csv).toContain('"15/11/26 10:00"');
    expect(csv).not.toContain('Fixture Customer');
    expect(csv.split('\r\n')[0]?.split(',')).toHaveLength(17);
    expect(hyperlocalDailyScope({ ...user, role: 1, userType: 2 }, [])).toEqual({
      ids: ['1'],
      global: false,
    });
    expect(hyperlocalDailyScope({ ...user, role: 1 }, [])).toEqual({ ids: [], global: true });
    await expect(service.read(user, { ...input, storeIds: ['2'] })).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    expect(calls).toHaveLength(2);
    expect((await service.read({ ...user, storeIds: [] }, input)).total).toBe(0);
  });
  it('fails closed without views or before fetching oversized complete exports', async () => {
    const db: Databases = {
        get() {
          throw new Error('Historical MySQL forbidden');
        },
        close: async () => {},
      },
      missing = hyperlocalDailyReportService(
        config,
        db,
        hyperlocalDailyOptions({}),
        undefined,
        clock,
      );
    await expect(missing.read(user, input)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    let calls = 0;
    const large = hyperlocalDailyReportService(
      config,
      db,
      hyperlocalDailyOptions({
        BQ_HYPERLOCAL_DAILY_VIEW: 'fixture-project.reports.hyperlocal_daily',
      }),
      {
        async queryReport() {
          calls++;
          return [{ count: 70001 }];
        },
      },
      clock,
    );
    await expect(large.read(user, input, true)).rejects.toMatchObject({ code: 'REPORT_TOO_LARGE' });
    expect(calls).toBe(1);
    expect(() => hyperlocalDailyOptions({ BQ_HYPERLOCAL_DAILY_VIEW: 'x`;DROP' })).toThrow();
  });
});
