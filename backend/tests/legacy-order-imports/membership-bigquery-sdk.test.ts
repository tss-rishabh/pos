import { BigQuery, type Job, type Query, type QueryRowsResponse } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  csvMembershipHistorySdk,
  csvMembershipHistorySql,
} from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import {
  membershipBigQueryFixture,
  membershipHistoryOptions,
  membershipHistoryScope,
} from './membership-bigquery-fixtures.js';

function setup() {
  const client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1' });
  const dry = client.job('fixture-dry'),
    live = client.job('fixture-live');
  dry.metadata = {
    statistics: {
      query: {
        totalBytesProcessed: '1234',
        referencedTables: [
          {
            projectId: 'tssgcp2025',
            datasetId: 'tss_mysql_raw_layer',
            tableId: 'fixture_membership_orders',
          },
        ],
      },
    },
  };
  const create = vi.fn(async (_request: Query): Promise<[Job, Record<string, never>]> => [
    live,
    {},
  ]);
  create.mockResolvedValueOnce([dry, {}]);
  vi.spyOn(client, 'createQueryJob').mockImplementation(create as BigQuery['createQueryJob']);
  const results = vi.fn(async (): Promise<QueryRowsResponse> => [
    [{ document: JSON.stringify(membershipBigQueryFixture().envelope) }],
    null,
    { jobComplete: true },
  ]);
  vi.spyOn(live, 'getQueryResults').mockImplementation(results as Job['getQueryResults']);
  const cancel = vi.fn(async (): Promise<[Record<string, never>]> => [{}]);
  vi.spyOn(live, 'cancel').mockImplementation(cancel as Job['cancel']);
  vi.spyOn(dry, 'cancel').mockImplementation(cancel as Job['cancel']);
  const factory = vi.fn(() => client),
    sdk = csvMembershipHistorySdk(membershipHistoryOptions, factory),
    query = csvMembershipHistorySql(membershipHistoryOptions, membershipHistoryScope);
  return { client, dry, live, create, results, cancel, factory, sdk, query };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('purpose-restricted bounded BigQuery SDK wire', () => {
  it('uses explicit temporal wrappers and read-only dry-run/execution budgets without automatic pagination', async () => {
    const f = setup();
    expect(await f.sdk.estimate(f.query)).toBe(1234n);
    expect(await f.sdk.execute(f.query)).toHaveLength(1);
    const dry = f.create.mock.calls[0]![0],
      live = f.create.mock.calls[1]![0];
    expect(dry).toMatchObject({
      dryRun: true,
      useLegacySql: false,
      useQueryCache: false,
      maximumBytesBilled: '50000000',
      jobTimeoutMs: 8000,
      location: 'asia-south1',
      labels: { application: 'pos-rewrite', resource: 'csv-membership-history' },
    });
    expect(live).toMatchObject({ dryRun: false, query: f.query.statement });
    expect(dry.params).toMatchObject({
      customer: '9007199254740993',
      asOf: { value: membershipHistoryScope.asOf },
      cutoff: { value: membershipHistoryScope.cutoff },
    });
    // Exercise installed SDK serialization itself, not only local wrapper types.
    const wire = BigQuery.valueToQueryParameter_(
      BigQuery.datetime(membershipHistoryScope.asOf),
      'DATETIME',
    );
    expect(wire).toMatchObject({
      parameterType: { type: 'DATETIME' },
      parameterValue: { value: membershipHistoryScope.asOf },
    });
    expect(f.results).toHaveBeenCalledWith({
      autoPaginate: false,
      maxResults: 2,
      maxApiCalls: 1,
      timeoutMs: 8000,
      wrapIntegers: true,
    });
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('rejects arbitrary SQL, altered typed bounds and cross-project query references', async () => {
    const f = setup();
    for (const query of [
      { ...f.query, statement: 'DELETE FROM private.table WHERE TRUE' },
      { ...f.query, types: { ...f.query.types, asOf: 'STRING' } },
      { ...f.query, params: { ...f.query.params, orderTake: 999999 } },
    ])
      await expect(f.sdk.execute(query)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_DEFINITION',
      });
    expect(f.factory).not.toHaveBeenCalled();
    f.dry.metadata = {
      statistics: {
        query: {
          totalBytesProcessed: '1',
          referencedTables: [
            { projectId: 'other-project', datasetId: 'private', tableId: 'users' },
          ],
        },
      },
    };
    await expect(f.sdk.estimate(f.query)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE',
    });
    expect(f.results).not.toHaveBeenCalled();
  });
  it('requires complete estimate metadata and no external routines before execution', async () => {
    const f = setup();
    f.dry.metadata = { statistics: { query: { totalBytesProcessed: '1' } } };
    await expect(f.sdk.estimate(f.query)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE',
    });
    const routines = setup();
    routines.dry.metadata = {
      statistics: {
        query: {
          totalBytesProcessed: '1',
          referencedTables: [
            { projectId: 'tssgcp2025', datasetId: 'tss_mysql_raw_layer', tableId: 'orders' },
          ],
          referencedRoutines: [{ projectId: 'private' }],
        },
      },
    };
    await expect(routines.sdk.estimate(routines.query)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE',
    });
  });
  it('refuses pagination or incomplete jobs and sanitizes failures without auto-reading more pages', async () => {
    const f = setup();
    await f.sdk.estimate(f.query);
    f.results.mockResolvedValue([[], { pageToken: 'PRIVATE_PAGE_TOKEN' }, { jobComplete: true }]);
    await expect(f.sdk.execute(f.query)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE',
    });
    expect(f.results).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalled();
  });
  it('bounds pending SDK calls, cancels a late created job and exposes no raw exception', async () => {
    vi.useFakeTimers();
    const f = setup();
    let release: (() => void) | undefined;
    f.create.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([f.live, {}]);
        }),
    );
    const task = expect(f.sdk.execute(f.query)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(8001);
    await task;
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.cancel).toHaveBeenCalled();
    expect(f.results).not.toHaveBeenCalled();
  });
  it('does not initialize credentials/network when already aborted', async () => {
    const f = setup(),
      abort = new AbortController();
    abort.abort();
    await expect(f.sdk.execute(f.query, abort.signal)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE',
    });
    expect(f.factory).not.toHaveBeenCalled();
  });
});
