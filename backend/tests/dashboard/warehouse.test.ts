import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { DashboardAuthority } from '../../src/modules/dashboard/authority.js';
import { dashboardWarehouse } from '../../src/modules/dashboard/warehouse.js';
import {
  readDashboardOptions,
  dashboardPublicationContract,
} from '../../src/modules/dashboard/options.js';

const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'dashboard-warehouse-test-'.repeat(3),
  MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
});
const now = Temporal.Instant.from('2026-06-15T06:30:00Z'),
  asOf = '2026-06-15T06:00:00.000000Z',
  generation = '9aee01c3-0e36-41fc-9d61-c222d0cbe307';
const options = readDashboardOptions({
  BQ_DASHBOARD_FACTS_VIEW: 'tssgcp2025.acceptance.dashboard_facts',
  BQ_DASHBOARD_PUBLICATIONS_VIEW: 'tssgcp2025.acceptance.dashboard_publications',
  BQ_DASHBOARD_CONTRACT: dashboardPublicationContract,
});
const scope: DashboardAuthority = {
  fingerprint: 'fixture',
  orderStoreIds: ['1', '2', '9007199254740993'],
  graphStores: [
    { id: '1', name: 'First' },
    { id: '9007199254740993', name: null },
  ],
};
function fixture() {
  const declaration = (store: string, count: string) => ({
    store_id: store,
    source_count: count,
    warehouse_count: count,
    source_hash: 'a'.repeat(64),
    warehouse_hash: 'a'.repeat(64),
    complete: true,
    as_of: asOf,
    contract: dashboardPublicationContract,
  });
  const pages: Record<string, Record<string, unknown>[]> = {
    'dashboard-publication': [
      { generation_id: generation, as_of: asOf, contract: dashboardPublicationContract },
    ],
    'dashboard-publication-stores': [
      declaration('1', '4'),
      declaration('2', '1'),
      declaration('9007199254740993', '0'),
    ],
    'dashboard-order-count': [
      { store_id: '1', published_rows: '4', unique_rows: '4', order_count: '3' },
      { store_id: '2', published_rows: '1', unique_rows: '1', order_count: '1' },
    ],
    'dashboard-monthly-orders': [
      { store_id: '1', year: 2026, month: 1, order_count: '2' },
      { store_id: '1', year: 2027, month: 2, order_count: '1' },
    ],
  };
  const calls: {
    statement: string;
    params: Record<string, unknown>;
    types: Record<string, string | string[]>;
    resource: string;
  }[] = [];
  const transport = {
    async queryReport(
      statement: string,
      params: Record<string, unknown>,
      types: Record<string, string | string[]>,
      resource = 'report',
    ) {
      calls.push({ statement, params, types, resource });
      return pages[resource] || [];
    },
  };
  const read = () =>
    dashboardWarehouse(config, options, transport).read(scope, 2026, '2026-01-01 00:00:00', now);
  return { pages, calls, transport, read };
}

describe('dashboard immutable source publication reader', () => {
  it('uses named scoped generation queries, source association counts, nullable names and the publication timestamp', async () => {
    const f = fixture(),
      result = await f.read();
    expect(result).toMatchObject({
      reader: 'bigquery',
      asOf,
      generationId: generation,
      contract: dashboardPublicationContract,
      year: 2026,
      orderAssociations: '4',
    });
    expect(result.series).toEqual([
      {
        id: '1',
        name: 'First',
        counts: ['2', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
      },
      { id: '9007199254740993', name: null, counts: Array<string>(12).fill('0') },
    ]);
    expect(f.calls).toHaveLength(4);
    expect(f.calls[2]!.params).toEqual({ generation, stores: scope.orderStoreIds });
    expect(f.calls[3]!.params).toEqual({
      generation,
      stores: ['1', '9007199254740993'],
      year_start: '2026-01-01 00:00:00',
    });
    expect(f.calls[3]!.types).toEqual({
      generation: 'STRING',
      stores: ['STRING'],
      year_start: 'DATETIME',
    });
    expect(
      f.calls.every(
        (call) =>
          /^SELECT/.test(call.statement) &&
          !call.statement.includes('9007199254740993') &&
          !call.statement.includes(generation),
      ),
    ).toBe(true);
  });
  it('rejects unconfigured or absent publications without substituting a different reader', async () => {
    const f = fixture();
    await expect(
      dashboardWarehouse(config, readDashboardOptions({}), f.transport).read(
        scope,
        2026,
        '2026-01-01 00:00:00',
        now,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'DASHBOARD_PUBLICATION_UNAVAILABLE' });
    expect(f.calls).toHaveLength(0);
    f.pages['dashboard-publication'] = [];
    await expect(f.read()).rejects.toMatchObject({ code: 'DASHBOARD_PUBLICATION_UNAVAILABLE' });
  });
  it('refuses stale and future-dated publication timestamps', async () => {
    for (const value of ['2026-06-15T05:29:59.999999Z', '2026-06-15T06:30:30.000001Z']) {
      const f = fixture();
      f.pages['dashboard-publication']![0]!.as_of = value;
      await expect(f.read()).rejects.toMatchObject({ code: 'DASHBOARD_PUBLICATION_STALE' });
    }
  });
  it('requires an exact complete per-store source count and hash manifest, including zero stores', async () => {
    const mutations: ((rows: Record<string, unknown>[]) => void)[] = [
      (rows) => {
        rows.pop();
      },
      (rows) => {
        rows.push({ ...rows[0]! });
      },
      (rows) => {
        rows[0]!.source_count = '5';
      },
      (rows) => {
        rows[0]!.warehouse_hash = 'b'.repeat(64);
      },
      (rows) => {
        rows[0]!.complete = false;
      },
      (rows) => {
        rows[0]!.as_of = '2026-06-15T06:01:00.000000Z';
      },
      (rows) => {
        rows[0]!.store_id = '99';
      },
    ];
    for (const mutation of mutations) {
      const f = fixture();
      mutation(f.pages['dashboard-publication-stores']!);
      await expect(f.read()).rejects.toMatchObject({
        status: 503,
        code: 'DASHBOARD_PUBLICATION_INVALID',
      });
    }
  });
  it('refuses duplicated physical associations, incomplete facts and impossible filtered totals', async () => {
    for (const field of ['unique_rows', 'published_rows', 'order_count']) {
      const f = fixture();
      f.pages['dashboard-order-count']![0]![field] = field === 'order_count' ? '5' : '3';
      await expect(f.read()).rejects.toMatchObject({ code: 'DASHBOARD_PUBLICATION_INVALID' });
    }
    const f = fixture();
    f.pages['dashboard-order-count']!.push({ ...f.pages['dashboard-order-count']![0]! });
    await expect(f.read()).rejects.toMatchObject({ code: 'DASHBOARD_PUBLICATION_INVALID' });
  });
  it('treats an upstream shape error as an unavailable source publication, never a client validation error', async () => {
    for (const value of [9007199254740992, -1, '1.5', null]) {
      const f = fixture();
      f.pages['dashboard-order-count']![0]!.order_count = value;
      await expect(f.read()).rejects.toMatchObject({
        status: 503,
        code: 'DASHBOARD_PUBLICATION_INVALID',
      });
    }
  });
  it('refuses the source graph’s ambiguous different-count overwrites rather than choosing a future year', async () => {
    const f = fixture();
    f.pages['dashboard-monthly-orders']!.push({
      store_id: '1',
      year: 2027,
      month: 1,
      order_count: '3',
    });
    await expect(f.read()).rejects.toMatchObject({
      status: 409,
      code: 'DASHBOARD_MONTH_AMBIGUOUS',
    });
  });
  it('rejects monthly facts from an inactive/unassigned graph store or an earlier year', async () => {
    for (const row of [
      { store_id: '2', year: 2026, month: 1, order_count: '1' },
      { store_id: '1', year: 2025, month: 1, order_count: '1' },
    ]) {
      const f = fixture();
      f.pages['dashboard-monthly-orders']!.push(row);
      await expect(f.read()).rejects.toMatchObject({
        status: 503,
        code: 'DASHBOARD_FACTS_INVALID',
      });
    }
  });
});
