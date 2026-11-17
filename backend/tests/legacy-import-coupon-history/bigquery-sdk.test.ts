import type { Query } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  couponHistorySdk,
  type CouponHistoryJob,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-bigquery-sdk.js';
import { couponWarehouseSql } from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-query.js';
import { warehouseFixture } from './warehouse-fixtures.js';
function sdkFixture() {
  const f = warehouseFixture(),
    input = couponWarehouseSql(f.options, f.scope, f.capture.controlHeadHash);
  const job: CouponHistoryJob = {
    metadata: {
      statistics: {
        query: {
          totalBytesProcessed: '12',
          statementType: 'SELECT',
          referencedTables: [
            {
              projectId: 'tssgcp2025',
              datasetId: 'tss_mysql_raw_layer',
              tableId: 'fixture_coupon_publications',
            },
          ],
          schema: { fields: [{ name: 'document', type: 'STRING' }] },
        },
      },
    },
    cancel: vi.fn(async () => undefined),
    getQueryResults: vi.fn(
      async () =>
        [
          f.rows(),
          null,
          { jobComplete: true, schema: { fields: [{ name: 'document', type: 'STRING' }] } },
        ] as const,
    ),
  };
  const create = vi.fn(async (_request: Query) => [job] as const),
    factory = vi.fn(() => ({ createQueryJob: create }));
  return { ...f, input, job, create, factory, sdk: couponHistorySdk(f.options, factory) };
}
afterEach(() => vi.useRealTimers());
describe('Google SDK boundary for generated bounded coupon SELECTs', () => {
  it('is lazy, uses fixed project/location, typed DATETIME, a consumed dry-run estimate and exactly one result page', async () => {
    const f = sdkFixture();
    expect(f.factory).not.toHaveBeenCalled();
    expect(await f.sdk.estimate(f.input)).toBe(12n);
    expect(await f.sdk.execute(f.input)).toEqual(f.rows());
    expect(f.create).toHaveBeenCalledTimes(2);
    const first = f.create.mock.calls[0]![0],
      second = f.create.mock.calls[1]![0];
    expect(first).toMatchObject({
      dryRun: true,
      useLegacySql: false,
      useQueryCache: false,
      location: 'asia-south1',
      maximumBytesBilled: '50000000',
      jobTimeoutMs: 8000,
      types: { asOf: 'DATETIME' },
    });
    expect(first.params).toHaveProperty('asOf', expect.objectContaining({ value: f.scope.asOf }));
    expect(second.dryRun).toBe(false);
    expect(f.job.getQueryResults).toHaveBeenCalledWith({
      autoPaginate: false,
      maxResults: 2,
      maxApiCalls: 1,
      timeoutMs: 8000,
      wrapIntegers: true,
    });
    await expect(f.sdk.execute(f.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_ESTIMATE_REQUIRED',
    });
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it('does not execute arbitrary/cloned statements or work before a successful bounded estimate', async () => {
    const f = sdkFixture();
    await expect(f.sdk.execute(f.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_ESTIMATE_REQUIRED',
    });
    await expect(f.sdk.estimate({ ...f.input })).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_QUERY_DEFINITION',
    });
    expect(() => Object.assign(f.input, { statement: 'DELETE FROM private' })).toThrow();
    expect(f.factory).not.toHaveBeenCalled();
  });
  it.each([
    'project',
    'dataset',
    'routine',
    'bytes',
    'overflow',
    'schema',
    'statement',
    'missing-tables',
  ] as const)('rejects %s dry-run metadata before any result request', async (kind) => {
    const f = sdkFixture(),
      q = {
        totalBytesProcessed: '12',
        statementType: 'SELECT',
        referencedTables: [
          { projectId: 'tssgcp2025', datasetId: 'tss_mysql_raw_layer', tableId: 'safe_view' },
        ],
        referencedRoutines: [] as unknown[],
        schema: { fields: [{ name: 'document', type: 'STRING' }] },
      };
    if (kind === 'project') q.referencedTables[0]!.projectId = 'other';
    if (kind === 'dataset') q.referencedTables[0]!.datasetId = 'other';
    if (kind === 'routine') q.referencedRoutines.push({});
    if (kind === 'bytes') q.totalBytesProcessed = '50000001';
    if (kind === 'overflow') q.totalBytesProcessed = '10000000000000000000';
    if (kind === 'schema') q.schema.fields[0]!.type = 'RECORD';
    if (kind === 'statement') q.statementType = 'SCRIPT';
    if (kind === 'missing-tables') q.referencedTables = [];
    f.job.metadata = { statistics: { query: q } };
    await expect(f.sdk.estimate(f.input)).rejects.toMatchObject({
      code: expect.stringMatching(
        /^ORDER_IMPORT_COUPON_PUBLICATION_(?:ESTIMATE_INVALID|WAREHOUSE_BUDGET)$/,
      ),
    });
    expect(f.job.getQueryResults).not.toHaveBeenCalled();
    expect(f.job.cancel).toHaveBeenCalledTimes(1);
    await expect(f.sdk.execute(f.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_ESTIMATE_REQUIRED',
    });
  });
  it.each([
    'next-page',
    'page-token',
    'incomplete',
    'extra-row',
    'empty',
    'extra-field',
    'bytes',
    'schema',
  ] as const)('rejects %s results with no pagination or false zero', async (kind) => {
    const f = sdkFixture();
    await f.sdk.estimate(f.input);
    let rows: unknown = f.rows(),
      next: unknown = null,
      response: unknown = { jobComplete: true };
    if (kind === 'next-page') next = { pageToken: 'secret' };
    if (kind === 'page-token') response = { jobComplete: true, pageToken: 'next' };
    if (kind === 'incomplete') response = { jobComplete: false };
    if (kind === 'extra-row') rows = [...f.rows(), ...f.rows()];
    if (kind === 'empty') rows = [];
    if (kind === 'extra-field') rows = [{ document: '{}', private: 'private-canary' }];
    if (kind === 'bytes') rows = [{ document: 'é'.repeat(800000) }];
    if (kind === 'schema')
      response = { jobComplete: true, schema: { fields: [{ name: 'document', type: 'JSON' }] } };
    f.job.getQueryResults = vi.fn(async () => [rows, next, response] as const);
    await expect(f.sdk.execute(f.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_INCOMPLETE',
    });
    expect(f.job.getQueryResults).toHaveBeenCalledTimes(1);
    expect(f.job.cancel).toHaveBeenCalledTimes(1);
  });
  it('does not instantiate a client for a previously aborted request', async () => {
    const f = sdkFixture(),
      controller = new AbortController();
    controller.abort();
    await expect(f.sdk.estimate(f.input, controller.signal)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_QUERY_DEFINITION',
    });
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('cancels a job that arrives after abort exactly once and never fetches its rows', async () => {
    const f = sdkFixture();
    let resolveJob: ((value: readonly [CouponHistoryJob]) => void) | undefined;
    const create = vi.fn(
      async (_request: Query) =>
        new Promise<readonly [CouponHistoryJob]>((resolve) => {
          resolveJob = resolve;
        }),
    );
    const sdk = couponHistorySdk(f.options, () => ({ createQueryJob: create })),
      controller = new AbortController(),
      pending = sdk.estimate(f.input, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_UNAVAILABLE',
    });
    resolveJob!([f.job]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.job.cancel).toHaveBeenCalledTimes(1);
    expect(f.job.getQueryResults).not.toHaveBeenCalled();
  });
  it('cancels hung result retrieval after the bounded deadline with no retries', async () => {
    vi.useFakeTimers();
    const f = sdkFixture();
    await f.sdk.estimate(f.input);
    f.job.getQueryResults = vi.fn(async () => new Promise<readonly [unknown]>(() => undefined));
    const pending = f.sdk.execute(f.input),
      observed = expect(pending).rejects.toMatchObject({
        code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_UNAVAILABLE',
      });
    await vi.advanceTimersByTimeAsync(8001);
    await observed;
    expect(f.job.cancel).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it('replaces SDK errors including credential/header/body/cause canaries with a static error', async () => {
    const f = sdkFixture(),
      sdk = couponHistorySdk(f.options, () => ({
        createQueryJob: async () => {
          throw Object.assign(Error('credential-canary'), {
            request: { authorization: 'header-canary' },
            response: { body: 'body-canary' },
            cause: Error('cause-canary'),
          });
        },
      }));
    try {
      await sdk.estimate(f.input);
      throw Error('should fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_UNAVAILABLE',
      });
      expect(String(error) + JSON.stringify(error)).not.toMatch(
        /credential-canary|header-canary|body-canary|cause-canary/,
      );
    }
  });
});
