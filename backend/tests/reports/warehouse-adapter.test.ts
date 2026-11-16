import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  dailyOfflineWarehouseContract,
  dailyWarehouseOptions,
} from '../../src/modules/daily-report-warehouse.js';
import { warehouseService } from '../../src/modules/warehouse.js';
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
const sdk = vi.hoisted(() => ({
  query: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('@google-cloud/bigquery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google-cloud/bigquery')>();
  return {
    ...actual,
    BigQuery: class {
      static date = actual.BigQuery.date;
      static datetime = actual.BigQuery.datetime;
      static time = actual.BigQuery.time;
      static timestamp = actual.BigQuery.timestamp;
      static geography = actual.BigQuery.geography;
      static valueToQueryParameter_ = actual.BigQuery.valueToQueryParameter_;
      query = sdk.query;
    },
  };
});
const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'warehouse-adapter-fixture-'.repeat(3),
  BIGQUERY_PROJECT_ID: 'fixture-project',
  BIGQUERY_DAILY_ROLLUP_TABLE: 'fixture-project.pos.daily',
});
describe('BigQuery daily report adapter', () => {
  beforeEach(() => sdk.query.mockReset());
  it('keeps named bindings/billing/time limits and unwraps SDK scalar values without unsafe ID conversion', async () => {
    sdk.query.mockResolvedValueOnce([
      [{ id: { value: '9007199254740993' }, amount: { value: '10.01' } }],
      {},
      {},
    ]);
    expect(
      await warehouseService(config).queryReport(
        'SELECT @id AS id',
        { id: '9007199254740993' },
        { id: 'STRING' },
        'daily-store-report',
      ),
    ).toEqual([{ id: '9007199254740993', amount: '10.01' }]);
    expect(sdk.query.mock.calls[0]?.[0]).toMatchObject({
      params: { id: '9007199254740993' },
      types: { id: 'STRING' },
      useLegacySql: false,
      maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
      jobTimeoutMs: 10000,
      labels: { application: 'pos-rewrite', resource: 'daily-store-report' },
    });
  });
  it('verifies SDK-wrapped zero-row publications before returning a complete empty historical result', async () => {
    const options = dailyWarehouseOptions({
        BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE: 'fixture-project.pos.publications',
        BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT: dailyOfflineWarehouseContract,
      }),
      stamp = { value: '2026-11-16 07:59:50+00' };
    sdk.query
      .mockResolvedValueOnce([[{ generation_id: 'fixture_generation', published_at: stamp }]])
      .mockResolvedValueOnce([
        [
          {
            generation_id: 'fixture_generation',
            store_id: '1',
            business_date: { value: '2026-11-15' },
            row_count: { value: '0' },
            row_hashes: [],
            published_at: stamp,
            cdc_watermark: { value: '2026-11-16 07:59:30+00' },
            source_position: 'mysql-bin.000042:123',
            publication_state: 'COMPLETE',
            offline_projection_contract: dailyOfflineWarehouseContract,
            business_timezone: 'Asia/Kolkata',
            source_baseline: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
            source_sql_sha256: '6ef32f5c50ca710f32aefeb5f0ecd92462e10a0687f78ad71da1d90e5220cd20',
          },
        ],
      ])
      .mockResolvedValueOnce([[]]);
    const result = await warehouseService(config, options, () =>
      Temporal.Instant.from('2026-11-16T08:00:00Z'),
    ).dailyRollups(['1'], '2026-11-15', '2026-11-15');
    expect(result.rows).toEqual([]);
    expect(result.publication.generationId).toBe('fixture_generation');
    expect(sdk.query).toHaveBeenCalledTimes(3);
    expect(sdk.query.mock.calls[2]?.[0].query).toContain('SHA256(TO_JSON_STRING(STRUCT(');
  });
  it('normalizes the actual SDK date/time wire values on the shared query path', async () => {
    sdk.query.mockResolvedValueOnce([[{ included: 1 }]]);
    await warehouseService(config).queryReport(
      'SELECT @day, @start',
      {
        day: '2026-11-01',
        start: '2026-11-01 13:00:00.123456',
      },
      { day: 'DATE', start: 'DATETIME' },
    );
    const params = z.record(z.string(), z.unknown()).parse(sdk.query.mock.calls[0]?.[0].params);
    expect(BigQuery.valueToQueryParameter_(params.day, 'DATE').parameterValue?.value).toBe(
      '2026-11-01',
    );
    expect(BigQuery.valueToQueryParameter_(params.start, 'DATETIME').parameterValue?.value).toBe(
      '2026-11-01 13:00:00.123456',
    );
  });
  it('rejects unsafe definitions and keeps raw SDK error details out of public errors', async () => {
    const service = warehouseService(config);
    await expect(service.queryReport('DELETE FROM protected', {}, {})).rejects.toMatchObject({
      code: 'INVALID_REPORT_DEFINITION',
    });
    await expect(
      service.queryReport('SELECT 1', {}, {}, 'fixture@example.test'),
    ).rejects.toMatchObject({ code: 'INVALID_REPORT_DEFINITION' });
    expect(sdk.query).not.toHaveBeenCalled();
    sdk.query.mockRejectedValueOnce(new Error('fixture@example.test secret SDK token'));
    await expect(
      service.queryReport('SELECT @id', { id: '1' }, { id: 'STRING' }),
    ).rejects.toMatchObject({
      code: 'WAREHOUSE_UNAVAILABLE',
      message: 'Historical reports are temporarily unavailable.',
    });
  });
});
