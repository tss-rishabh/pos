import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  sealPaymentCorrectionPartition,
  paymentCorrectionPublicationContract,
} from '../../src/modules/finance/payment-correction-publication.js';
import { reportService } from '../../src/modules/reports.js';
import {
  dailyOfflineWarehouseContract,
  dailyWarehouseOptions,
  readDailyWarehouseRollups,
  type DailyWarehouseQuery,
} from '../../src/modules/daily-report-warehouse.js';
const now = Temporal.Instant.from('2026-11-16T08:00:00Z'),
  config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'daily-publication-fixture-'.repeat(3),
    BIGQUERY_DAILY_ROLLUP_TABLE: 'fixture-project.pos.daily',
  }),
  options = dailyWarehouseOptions({
    BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE: 'fixture-project.pos.publications',
    BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT: dailyOfflineWarehouseContract,
  });
const partition = (store = '1', date = '2026-11-15', rowCount = 0) => ({
  generation_id: 'fixture_generation_42',
  store_id: store,
  business_date: date,
  row_count: rowCount,
  row_hashes:
    rowCount === 0 ? [] : rowCount === 1 ? ['a'.repeat(64)] : ['a'.repeat(64), 'b'.repeat(64)],
  published_at: '2026-11-16 07:59:50+00',
  cdc_watermark: '2026-11-16 07:59:30+00',
  source_position: 'mysql-bin.000042:123456',
  publication_state: 'COMPLETE',
  offline_projection_contract: dailyOfflineWarehouseContract,
  business_timezone: 'Asia/Kolkata',
  source_baseline: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
  source_sql_sha256: '6ef32f5c50ca710f32aefeb5f0ecd92462e10a0687f78ad71da1d90e5220cd20',
});
const rollup = (store = '1', date = '2026-11-15', source = 'store_orders') => ({
  generation_id: 'fixture_generation_42',
  store_id: store,
  order_date: date,
  order_source: source,
  offline_projection_contract: dailyOfflineWarehouseContract,
  store_name: 'Fixture ' + store,
  location_code: 'FIX-' + store,
  order_count: 2,
  qty: 1,
  revenue: 10,
  membership_purchase_orders: 0,
  membership_orders_total: 0,
  membership_revenue: 0,
  tss_money_used_total: 0,
  tss_points_used_total: 0,
  pg_discount_total: 0,
  gift_voucher_total: 0,
  district_total: 0,
  cash_total: 12.02,
  total_online: 0,
  pending_offline_orders: source === 'store_orders' ? 1 : 0,
  banking_amount: 5,
  footfall: 4,
  target: 100,
  row_hash: 'a'.repeat(64),
});
function fixture(
  partitions: Record<string, unknown>[],
  rows: Record<string, unknown>[],
  generation: Record<string, unknown>[] = [
    { generation_id: 'fixture_generation_42', published_at: '2026-11-16 07:59:50+00' },
  ],
) {
  const calls: Array<{
    sql: string;
    params: Record<string, unknown>;
    types: Record<string, string | string[]>;
    resource: string | undefined;
  }> = [];
  const query: DailyWarehouseQuery = async (sql, params, types, resource) => {
    calls.push({ sql, params, types, resource });
    return sql.includes('GROUP BY generation_id')
      ? generation
      : sql.includes('fixture-project.pos.publications')
        ? partitions
        : rows;
  };
  return { query, calls };
}
describe('daily warehouse publication and offline projection boundaries', () => {
  it('binds one immutable generation, verifies every requested partition and returns its CDC provenance', async () => {
    const f = fixture(
      [
        partition('1', '2026-11-15', 1),
        partition('1', '2026-11-16', 0),
        partition('2', '2026-11-15', 0),
        partition('2', '2026-11-16', 1),
      ],
      [rollup(), rollup('2', '2026-11-16', 'online_orders')],
    );
    const result = await readDailyWarehouseRollups(
      config,
      options,
      f.query,
      ['2', '1'],
      '2026-11-15',
      '2026-11-16',
      now,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.publication).toEqual({
      generationId: 'fixture_generation_42',
      publishedAt: '2026-11-16T07:59:50Z',
      cdcWatermark: '2026-11-16T07:59:30Z',
      sourcePosition: 'mysql-bin.000042:123456',
    });
    expect(f.calls).toHaveLength(3);
    for (const call of f.calls) {
      expect(call.params).toMatchObject({
        stores: ['1', '2'],
        start: '2026-11-15',
        end: '2026-11-16',
      });
      expect(call.types).toMatchObject({ stores: ['STRING'], start: 'DATE', end: 'DATE' });
      expect(call.sql).not.toContain('fixture_generation_42');
      expect(call.sql).toContain('@stores');
    }
    expect(f.calls[0]?.params).toMatchObject({
      expected_partitions: 4,
      contract: dailyOfflineWarehouseContract,
    });
    expect(f.calls[2]?.params.generation).toBe('fixture_generation_42');
  });
  it('accepts an empty result only when the requested partition is explicitly published with zero rows', async () => {
    const valid = fixture([partition()], []);
    expect(
      (
        await readDailyWarehouseRollups(
          config,
          options,
          valid.query,
          ['1'],
          '2026-11-15',
          '2026-11-15',
          now,
        )
      ).rows,
    ).toEqual([]);
    expect(valid.calls).toHaveLength(3);
    const unpublished = fixture([], [], []);
    await expect(
      readDailyWarehouseRollups(
        config,
        options,
        unpublished.query,
        ['1'],
        '2026-11-15',
        '2026-11-15',
        now,
      ),
    ).rejects.toMatchObject({ code: 'DAILY_WAREHOUSE_PUBLICATION_INVALID' });
    expect(unpublished.calls).toHaveLength(1);
    const incomplete = fixture([partition('1', '2026-11-15', 1)], []);
    await expect(
      readDailyWarehouseRollups(
        config,
        options,
        incomplete.query,
        ['1'],
        '2026-11-15',
        '2026-11-15',
        now,
      ),
    ).rejects.toMatchObject({ code: 'DAILY_WAREHOUSE_PUBLICATION_INVALID' });
  });
  it('rejects stale/future watermarks, mixed positions, duplicates, incomplete scope and different source contracts', async () => {
    const cases: Array<{
      partitions: Record<string, unknown>[];
      rows: Record<string, unknown>[];
      code?: string;
    }> = [
      {
        partitions: [{ ...partition(), cdc_watermark: '2026-11-16T07:54:59Z' }],
        rows: [],
        code: 'DAILY_WAREHOUSE_PUBLICATION_STALE',
      },
      {
        partitions: [{ ...partition(), cdc_watermark: '2026-11-16T08:00:31Z' }],
        rows: [],
        code: 'DAILY_WAREHOUSE_PUBLICATION_STALE',
      },
      { partitions: [{ ...partition(), publication_state: 'PENDING' }], rows: [] },
      { partitions: [{ ...partition(), business_timezone: 'UTC' }], rows: [] },
      { partitions: [{ ...partition(), offline_projection_contract: 'legacy-rollup' }], rows: [] },
      { partitions: [{ ...partition(), source_sql_sha256: 'f'.repeat(64) }], rows: [] },
      { partitions: [partition(), partition()], rows: [] },
      { partitions: [partition('2')], rows: [] },
      { partitions: [partition()], rows: [rollup()] },
      {
        partitions: [partition('1', '2026-11-15', 1)],
        rows: [{ ...rollup(), row_hash: 'b'.repeat(64) }],
      },
      { partitions: [{ ...partition('1', '2026-11-15', 1), row_hashes: [] }], rows: [rollup()] },
      { partitions: [partition('1', '2026-11-15', 2)], rows: [rollup(), rollup()] },
      {
        partitions: [partition('1', '2026-11-15', 1)],
        rows: [{ ...rollup(), generation_id: 'different_generation' }],
      },
    ];
    for (const value of cases) {
      const f = fixture(value.partitions, value.rows);
      await expect(
        readDailyWarehouseRollups(config, options, f.query, ['1'], '2026-11-15', '2026-11-15', now),
      ).rejects.toMatchObject({ code: value.code || 'DAILY_WAREHOUSE_PUBLICATION_INVALID' });
    }
    for (const field of ['source_position', 'cdc_watermark', 'published_at'] as const) {
      const second = {
          ...partition('2'),
          [field]: field === 'source_position' ? 'mysql-bin.000042:123457' : '2026-11-16T07:59:45Z',
        },
        f = fixture([partition(), second], []);
      await expect(
        readDailyWarehouseRollups(
          config,
          options,
          f.query,
          ['1', '2'],
          '2026-11-15',
          '2026-11-15',
          now,
        ),
      ).rejects.toMatchObject({ code: 'DAILY_WAREHOUSE_PUBLICATION_INVALID' });
    }
  });
  it('requires explicit publication configuration and rejects unsafe identifiers without running warehouse queries', async () => {
    const query = vi.fn<DailyWarehouseQuery>();
    await expect(
      readDailyWarehouseRollups(
        config,
        dailyWarehouseOptions({}),
        query,
        ['1'],
        '2026-11-15',
        '2026-11-15',
        now,
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(query).not.toHaveBeenCalled();
    expect(() =>
      dailyWarehouseOptions({
        BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE: 'project.dataset.view;DELETE',
      }),
    ).toThrow();
  });
  it('keeps historical report rows, banking and auxiliary figures in the same published generation with no MySQL fallback', async () => {
    const f = fixture([partition('1', '2026-11-15', 1)], [rollup()]),
      get = vi.fn(() => {
        throw new Error('No MySQL history access.');
      }),
      db: Databases = { get, close: async () => {} },
      auxiliary = vi.fn(async () => ({ footfall: {}, target: {} })),
      user: Principal = {
        id: '1',
        name: 'Fixture',
        email: 'fixture@example.test',
        role: 1,
        userType: 1,
        storeIds: ['1'],
      };
    const warehouse = {
      dailyRollups: (stores: string[], from: string, to: string) =>
        readDailyWarehouseRollups(config, options, f.query, stores, from, to, now),
      auxiliary,
    };
    const proofKey = 'daily-correction-fixture-proof-key-'.repeat(2),
      paymentCorrections = {
        proofKey,
        publicationTable: 'fixture-project.pos.payment_publications',
      };
    const queryFor = (baselineHash: string | null) => async () => [
      sealPaymentCorrectionPartition(
        {
          contract: paymentCorrectionPublicationContract,
          kind: 'daily',
          generationId: 'fixture_generation_42',
          sourcePosition: 'mysql-bin.000042:123456',
          cdcWatermark: '2026-11-16T07:59:30Z',
          publishedAt: '2026-11-16T07:59:50Z',
          businessTimezone: 'Asia/Kolkata',
          storeId: '1',
          businessDate: '2026-11-15',
          payload: {
            storeName: 'Fixture 1',
            locationCode: 'FIX-1',
            baselineHash,
            sourceCashRemoval: '0.00',
            sourceOnlineRemoval: '0.00',
            sourceOrderCountRemoval: 0,
            cashIn: '0.00',
            cashOut: '0.00',
            logicalOrderCount: 0,
          },
        },
        proofKey,
      ),
    ];
    const result = await reportService(config, db, {
      warehouse,
      clock: () => now,
      paymentCorrections,
      paymentCorrectionQuery: queryFor('a'.repeat(64)),
    }).daily(user, {
      storeIds: ['1'],
      from: '2026-11-15',
      to: '2026-11-15',
    });
    expect(result.reader).toBe('bigquery');
    expect(result.pendingOrderCount).toBe(1);
    expect(result.data[0]).toMatchObject({
      cash: 12.02,
      total_orders: 2,
      total_revenue: 10,
      total_qty: 1,
      banking: 5,
      footfall: 4,
      target: 100,
      pending_offline_orders: 1,
    });
    expect(get).not.toHaveBeenCalled();
    expect(auxiliary).not.toHaveBeenCalled();
    const empty = fixture([partition()], []);
    expect(
      (
        await reportService(config, db, {
          warehouse: {
            ...warehouse,
            dailyRollups: (stores, from, to) =>
              readDailyWarehouseRollups(config, options, empty.query, stores, from, to, now),
          },
          clock: () => now,
          paymentCorrections,
          paymentCorrectionQuery: queryFor(null),
        }).daily(user, { storeIds: ['1'], from: '2026-11-15', to: '2026-11-15' })
      ).data,
    ).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
