import { Temporal } from '@js-temporal/polyfill';
import { describe, it, expect, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import { reportService } from '../../src/modules/reports.js';
import type { DailyWarehouseQuery } from '../../src/modules/daily-report-warehouse.js';
import {
  paymentCorrectionPublicationContract,
  sealPaymentCorrectionPartition,
  readPaymentCorrectionPartitions,
  type PaymentCorrectionPartition,
} from '../../src/modules/finance/payment-correction-publication.js';
import { applyDailyPaymentCorrectionPartitions } from '../../src/modules/daily-report-corrections.js';
import { emptyDailyStoreRow } from '../../src/modules/daily-report-offline.js';
const key = 'fixture-financial-publication-proof-'.repeat(2),
  now = Temporal.Instant.from('2026-11-17T08:00:00Z'),
  options = { table: 'fixture-project.finance.payment_publications', proofKey: key },
  base = {
    generationId: 'fixture_generation',
    sourcePosition: 'mysql-bin.42:123',
    cdcWatermark: '2026-11-17T07:59:30Z',
    publishedAt: '2026-11-17T07:59:50Z',
  },
  scope = { kind: 'daily' as const, storeIds: ['1'], from: '2026-11-15', to: '2026-11-15' };
function partition(
  overrides: Partial<Extract<PaymentCorrectionPartition, { kind: 'daily' }>> = {},
): Extract<PaymentCorrectionPartition, { kind: 'daily' }> {
  return {
    contract: paymentCorrectionPublicationContract,
    kind: 'daily',
    ...base,
    businessTimezone: 'Asia/Kolkata',
    storeId: '1',
    businessDate: '2026-11-15',
    payload: {
      storeName: 'Fixture store',
      locationCode: 'FIX',
      baselineHash: 'a'.repeat(64),
      sourceCashRemoval: '0.00',
      sourceOnlineRemoval: '100.00',
      sourceOrderCountRemoval: 1,
      cashIn: '100.00',
      cashOut: '0.00',
      logicalOrderCount: 1,
    },
    ...overrides,
  };
}
function queryFor(records: Record<string, unknown>[]) {
  const calls: string[] = [];
  const query: DailyWarehouseQuery = async (statement) => {
    calls.push(statement);
    return statement.includes('GROUP BY generation_id')
      ? [{ generationId: base.generationId }]
      : records;
  };
  return { query, calls };
}
describe('sealed common-generation payment cash publications', () => {
  it('requires an explicit signed zero partition rather than treating missing rows as zero', async () => {
    const body = partition({
        payload: {
          ...partition().payload,
          baselineHash: null,
          sourceOnlineRemoval: '0.00',
          sourceOrderCountRemoval: 0,
          cashIn: '0.00',
          cashOut: '0.00',
          logicalOrderCount: 0,
        },
      }),
      value = queryFor([sealPaymentCorrectionPartition(body, key)]);
    expect(
      (
        await readPaymentCorrectionPartitions(
          options,
          value.query,
          scope,
          'Asia/Kolkata',
          now,
          base,
        )
      ).partitions.size,
    ).toBe(1);
    await expect(
      readPaymentCorrectionPartitions(
        options,
        queryFor([]).query,
        scope,
        'Asia/Kolkata',
        now,
        base,
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_PUBLICATION_INVALID' });
    expect(
      applyDailyPaymentCorrectionPartitions([], new Map(), new Map([['1\0' + scope.from, body]])),
    ).toEqual([]);
  });
  it.each([
    'signature',
    'generation',
    'position',
    'scope',
    'timezone',
    'duplicate',
    'money',
    'contract',
    'malformed',
  ] as const)(
    'rejects %s corruption without returning a partial financial projection',
    async (defect) => {
      const body = partition(),
        record = sealPaymentCorrectionPartition(body, key);
      const changed: Record<string, unknown> = { ...record };
      if (defect === 'signature') changed.proofHash = '0'.repeat(64);
      else if (defect === 'malformed') changed.body = '{"private-token-canary":';
      else {
        const raw: Record<string, unknown> = JSON.parse(record.body) as Record<string, unknown>;
        if (defect === 'generation') raw.generationId = 'other_generation';
        if (defect === 'position') raw.sourcePosition = 'mysql-bin.42:456';
        if (defect === 'scope') raw.storeId = '2';
        if (defect === 'timezone') raw.businessTimezone = 'UTC';
        if (defect === 'contract') raw.contract = 'legacy-unsupported';
        if (defect === 'money') raw.payload = { ...body.payload, cashIn: 'NaN' };
        changed.body = JSON.stringify(raw);
      }
      const records = defect === 'duplicate' ? [record, record] : [changed];
      await expect(
        readPaymentCorrectionPartitions(
          options,
          queryFor(records).query,
          scope,
          'Asia/Kolkata',
          now,
          base,
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_PUBLICATION_INVALID' });
    },
  );
  it('rejects a correctly signed but stale publication and mixed independent source positions', async () => {
    const stale = partition({
      publishedAt: '2026-11-17T07:40:00Z',
      cdcWatermark: '2026-11-17T07:39:30Z',
    });
    await expect(
      readPaymentCorrectionPartitions(
        options,
        queryFor([sealPaymentCorrectionPartition(stale, key)]).query,
        scope,
        'Asia/Kolkata',
        now,
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_PUBLICATION_STALE' });
    const second = partition({ storeId: '2', sourcePosition: 'mysql-bin.42:456' });
    await expect(
      readPaymentCorrectionPartitions(
        options,
        queryFor([
          sealPaymentCorrectionPartition(partition(), key),
          sealPaymentCorrectionPartition(second, key),
        ]).query,
        { ...scope, storeIds: ['1', '2'] },
        'Asia/Kolkata',
        now,
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_PUBLICATION_INVALID' });
  });
  it('keeps values bound and never queries an unconfigured or unsafe relation/key', async () => {
    const query = vi.fn<DailyWarehouseQuery>();
    await expect(
      readPaymentCorrectionPartitions({}, query, scope, 'Asia/Kolkata', now),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    await expect(
      readPaymentCorrectionPartitions(
        { ...options, table: 'project.dataset.table;DELETE' },
        query,
        scope,
        'Asia/Kolkata',
        now,
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_PUBLICATION_INVALID' });
    expect(query).not.toHaveBeenCalled();
    const f = queryFor([sealPaymentCorrectionPartition(partition(), key)]);
    await readPaymentCorrectionPartitions(options, f.query, scope, 'Asia/Kolkata', now);
    expect(f.calls).toHaveLength(2);
    for (const sql of f.calls) {
      expect(sql).toContain('@stores');
      expect(sql).not.toContain('mysql-bin.42:123');
    }
  });
  it('replaces only source payment baselines and keeps product/benefit metrics unchanged', () => {
    const source = {
        ...emptyDailyStoreRow({ id: '1', name: 'Fixture store', locationCode: 'FIX' }, scope.from),
        order_count: 1,
        qty: 3,
        revenue: 80,
        total_online: 100,
      },
      body = partition();
    const [result] = applyDailyPaymentCorrectionPartitions(
      [source],
      new Map([['1\0' + scope.from, 'a'.repeat(64)]]),
      new Map([['1\0' + scope.from, body]]),
    );
    expect(result).toMatchObject({
      order_count: 1,
      cash_total: 100,
      total_online: 0,
      qty: 3,
      revenue: 80,
      payment_correction_cash_out: 0,
    });
    expect(source.total_online).toBe(100);
    expect(() =>
      applyDailyPaymentCorrectionPartitions(
        [source],
        new Map([['1\0' + scope.from, 'b'.repeat(64)]]),
        new Map([['1\0' + scope.from, body]]),
      ),
    ).toThrow();
  });
  it('the actual historical DSR conserves original cash, correction outflow and later cash-in across three dates without MySQL', async () => {
    const dates = ['2026-11-14', '2026-11-15', '2026-11-16'],
      get = vi.fn(() => {
        throw new Error('No historical MySQL fallback');
      }),
      db: Databases = { get, close: async () => {} },
      source = {
        ...emptyDailyStoreRow({ id: '1', name: 'Fixture store', locationCode: 'FIX' }, dates[0]!),
        order_count: 1,
        qty: 3,
        revenue: 80,
        cash_total: 100,
        order_source: 'store_orders',
        banking_amount: 0,
        footfall: null,
        target: null,
        row_hash: 'a'.repeat(64),
      };
    const payloads = dates.map((date, index) =>
      partition({
        businessDate: date,
        payload: {
          ...partition().payload,
          baselineHash: index === 0 ? 'a'.repeat(64) : null,
          sourceCashRemoval: index === 0 ? '100.00' : '0.00',
          sourceOnlineRemoval: '0.00',
          sourceOrderCountRemoval: index === 0 ? 1 : 0,
          cashIn: index === 1 ? '0.00' : '100.00',
          cashOut: index === 1 ? '100.00' : '0.00',
          logicalOrderCount: index === 0 ? 1 : 0,
        },
      }),
    );
    const warehouse = {
        async dailyRollups() {
          return { publication: base, rows: [source] };
        },
        async auxiliary() {
          throw new Error('No unrelated warehouse read');
        },
      },
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'fixture-historical-dsr-session-'.repeat(3),
      }),
      service = reportService(config, db, {
        warehouse,
        clock: () => now,
        paymentCorrections: { proofKey: key, publicationTable: options.table },
        paymentCorrectionQuery: queryFor(
          payloads.map((body) => sealPaymentCorrectionPartition(body, key)),
        ).query,
      });
    const result = await service.daily(
      {
        id: '1',
        name: 'Fixture',
        email: 'fixture@example.test',
        role: 1,
        userType: 1,
        storeIds: ['1'],
      },
      { storeIds: ['1'], from: dates[0]!, to: dates[2]! },
    );
    expect(
      result.data.map((row) => [
        row.date,
        row.cash,
        row.payment_correction_cash_out,
        row.cash_after_payment_corrections,
        row.total_orders,
        row.total_qty,
        row.total_revenue,
      ]),
    ).toEqual([
      [dates[0], 100, 0, 100, 1, 3, 80],
      [dates[1], 0, 100, -100, 0, 0, 0],
      [dates[2], 100, 0, 100, 0, 0, 0],
    ]);
    expect(result.totals).toMatchObject({
      cash: 200,
      payment_correction_cash_out: 100,
      cash_after_payment_corrections: 100,
      total_orders: 1,
      total_qty: 3,
      total_revenue: 80,
    });
    expect(get).not.toHaveBeenCalled();
  });
});
