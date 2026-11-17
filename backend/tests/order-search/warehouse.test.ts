import { describe, expect, it, vi } from 'vitest';
import { orderRange } from '../../src/modules/order-history/contracts.js';
import {
  sourceHistoricalSearch,
  searchIndexRowsHash,
} from '../../src/modules/order-history/search/warehouse.js';
import { readOrderSearchOptions } from '../../src/modules/order-history/search/options.js';
import { sourceSelect, sourceFactHash } from '../../src/modules/order-history/search/reducer.js';
import { orderSearchInput } from '../../src/modules/order-history/search/contracts.js';
import { config, now, options, scope, fixtures, fact } from './fixtures.js';
const range = orderRange({ from: '2026-11-16', to: '2026-11-16' }, config.BUSINESS_TIMEZONE, now);
function setup(mutate?: (data: ReturnType<typeof fixtures>) => void, bytes = 1n) {
  const data = fixtures();
  mutate?.(data);
  const calls: { statement: string; params: Record<string, unknown> }[] = [];
  const query = vi.fn(async (statement: string, params: Record<string, unknown>) => {
    calls.push({ statement, params });
    return statement.includes('fact_json,fact_hash')
      ? [data.fact]
      : statement.includes('index_json,index_hash')
        ? [data.index]
        : [data.publication];
  });
  return {
    data,
    calls,
    query,
    reader: sourceHistoricalSearch(config, options, {
      clock: () => now,
      estimate: async () => bytes,
      query,
    }),
  };
}
describe('qualified original-order search publications', () => {
  it('binds date partitions/generation/IDs/shards and verifies exact native fact/index hashes', async () => {
    const test = setup(),
      result = await test.reader.range(scope, range);
    expect(result.indexes).toHaveLength(1);
    expect(await result.facts([fact.id])).toEqual([fact]);
    expect(test.calls.map((row) => row.params)).toMatchObject([
      { scopeKeys: ['store:1'], startDate: '2026-11-16', endDate: '2026-11-16' },
      { generation: test.data.publication.generation_id, days: ['2026-11-16'] },
      { orders: [fact.id], orderShards: [Number(BigInt(fact.id) % 8192n)] },
    ]);
    expect(
      test.calls.every(
        (row) =>
          !row.statement.includes(fact.id) && !row.statement.includes('synthetic-checkpoint'),
      ),
    ).toBe(true);
  });
  it('verifies point manifests before unknown-age queue facts and refuses current/future point rows', async () => {
    const data = fixtures(fact, 'order:' + fact.id),
      query = vi.fn(async (statement: string) =>
        statement.includes('fact_json,fact_hash')
          ? [data.fact]
          : statement.includes('index_json,index_hash')
            ? [data.index]
            : [data.publication],
      );
    const reader = sourceHistoricalSearch(config, options, {
        clock: () => now,
        query,
        estimate: async () => 1n,
      }),
      result = await reader.ids(scope, [fact.id], '2026-11-17 00:00:00');
    expect(await result.facts([fact.id])).toEqual([fact]);
    await expect(reader.ids(scope, [fact.id], '2026-11-16 00:00:00')).rejects.toMatchObject({
      code: 'ORDER_SEARCH_PUBLICATION_INVALID',
    });
  });
  it.each([
    'count',
    'hash',
    'key',
    'stale',
    'future',
    'payload',
    'index',
    'scope',
    'generation',
  ] as const)('refuses %s corruption without partial rows', async (kind) => {
    const test = setup((data) => {
      switch (kind) {
        case 'count':
          data.publication.source_rows = '2';
          break;
        case 'hash':
          data.publication.source_hash = '0'.repeat(64);
          break;
        case 'key':
          data.publication.contact_key_id = 'different-key';
          break;
        case 'stale':
          data.publication.source_snapshot_at = new Date(now - 86400000).toISOString();
          break;
        case 'future':
          data.publication.source_snapshot_at = new Date(now + 60000).toISOString();
          break;
        case 'payload':
          data.fact.fact_json += ' ';
          break;
        case 'index':
          data.index.index_json += ' ';
          break;
        case 'scope':
          data.index.scope_key = 'store:2';
          break;
        case 'generation':
          data.publication.scope_key = 'store:2';
          break;
      }
    });
    await expect(
      (async () => {
        const result = await test.reader.range(scope, range);
        return result.facts([fact.id]);
      })(),
    ).rejects.toMatchObject({ code: 'ORDER_SEARCH_PUBLICATION_INVALID' });
  });
  it('distinguishes independently verified empty scope/day from missing publication', async () => {
    const test = setup();
    test.data.publication.source_rows = test.data.publication.warehouse_rows = '0';
    test.data.publication.source_hash = test.data.publication.warehouse_hash = searchIndexRowsHash(
      [],
    );
    test.query.mockImplementation(async (statement) =>
      statement.includes('index_json,index_hash') ? [] : [test.data.publication],
    );
    expect((await test.reader.range(scope, range)).indexes).toEqual([]);
    test.query.mockImplementation(async () => []);
    await expect(test.reader.range(scope, range)).rejects.toMatchObject({
      code: 'ORDER_SEARCH_PUBLICATION_REQUIRED',
    });
  });
  it('refuses missing comparison keys even when an independent digest matches the malformed index', async () => {
    const test = setup((data) => {
      const value = JSON.parse(data.index.index_json) as Record<string, unknown>;
      value.phoneKey = '';
      data.index.index_json = JSON.stringify(value);
      data.index.index_hash = sourceFactHash(data.index.index_json);
      data.publication.source_hash = data.publication.warehouse_hash = searchIndexRowsHash([
        data.index,
      ]);
    });
    await expect(test.reader.range(scope, range)).rejects.toMatchObject({
      code: 'ORDER_SEARCH_PUBLICATION_INVALID',
    });
  });
  it('gates missing mappings and cumulative dry-run budget before execution', async () => {
    const query = vi.fn(async () => []),
      estimate = vi.fn(async () => 1n),
      reader = sourceHistoricalSearch(config, readOrderSearchOptions({}), { query, estimate });
    await expect(reader.range(scope, range)).rejects.toMatchObject({
      code: 'ORDER_SEARCH_PUBLICATION_REQUIRED',
    });
    expect(query).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
    const test = setup(undefined, BigInt(config.BIGQUERY_MAX_BYTES_BILLED));
    await expect(test.reader.range(scope, range)).rejects.toMatchObject({
      code: 'ORDER_SEARCH_PROJECTION_REQUIRED',
    });
    expect(test.query).toHaveBeenCalledTimes(1);
  });
  it('preserves phone fallback before email, numeric literal search and arbitrary-width IDs', () => {
    const input = orderSearchInput.parse({
        storeIds: ['1'],
        mobile: '555',
        email: 'synthetic@example.invalid',
      }),
      one = fixtures().index,
      two = fixtures({
        ...fact,
        id: '9',
        userId: '8',
        customer: { id: '8', first: 'B', last: 'C' },
        stores: fact.stores.map((row) => ({ ...row, orderId: '9' })),
        phoneKey: 'd'.repeat(64),
        userPhoneKey: 'a'.repeat(64),
        emailKey: 'e'.repeat(64),
      }).index;
    const values = [JSON.parse(one.index_json), JSON.parse(two.index_json)];
    expect(
      sourceSelect(values, scope, input, {
        orderPhone: 'a'.repeat(64),
        userPhone: 'a'.repeat(64),
        email: 'e'.repeat(64),
      }).count,
    ).toBe('0');
  });
});
