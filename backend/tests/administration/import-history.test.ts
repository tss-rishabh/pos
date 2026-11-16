import {
  historicalInventoryImport,
  mysqlImportCutoff,
} from '../../src/modules/administration/import-time.js';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  inventoryImportHistory,
  readImportHistoryOptions,
  reduceHistoricalImport,
} from '../../src/modules/administration/import-history.js';
import type { inventoryImports } from '../../src/modules/administration/import-schema.js';

const config = readConfig({
  NODE_ENV: 'test',
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_history_unit',
  SESSION_SECRET: 'fixture-history-secret-'.repeat(3),
  BIGQUERY_PROJECT_ID: 'fixture-project',
});
const options = readImportHistoryOptions({
  BQ_INVENTORY_IMPORTS_VIEW: 'fixture-project.pos_rewrite.inventory_imports',
  BQ_INVENTORY_IMPORT_ROWS_VIEW: 'fixture-project.pos_rewrite.inventory_import_rows',
});
const now = () => Temporal.Instant.from('2026-11-16T00:00:00Z');
const fixture = () => {
  const anchor: typeof inventoryImports.$inferSelect = {
    id: randomUUID(),
    sequence: 9007199254740993n,
    profile: 'stock',
    actorId: '9007199254740997',
    requestId: null,
    checksum: 'a'.repeat(64),
    name: 'Fixture.csv',
    state: 'COMPLETED',
    errorCode: null,
    totalRows: 3,
    processedRows: 3,
    successfulRows: 2,
    failedRows: 1,
    createdAt: '2026-11-10 00:00:00.000',
    updatedAt: '2026-11-10 00:01:00.000',
  };
  const metadata: Record<string, unknown> = {
    ...anchor,
    sequence: String(anchor.sequence),
    totalRows: '3',
    processedRows: '3',
    successfulRows: '2',
    failedRows: '1',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:01:00.000Z',
    recordCount: '3',
    distinctRecords: '3',
    minimumRecord: '2',
    maximumRecord: '4',
    succeededCount: '2',
    failedCount: '1',
    cancelledCount: '0',
    unexpectedCount: '0',
  };
  const command = {
    productId: '9007199254740999',
    storeId: '1',
    movement: 'none',
    quantity: 0,
    available: true,
    archived: false,
  };
  const rows: Record<string, unknown>[] = [2, 3, 4].map((rowNumber) => ({
    importId: anchor.id,
    actorId: anchor.actorId,
    checksum: anchor.checksum,
    updatedAt: '2026-11-10T00:01:00.000Z',
    rowNumber: String(rowNumber),
    cells: JSON.stringify([
      rowNumber === 4 ? '=HYPERLINK("fixture")' : command.productId,
      '1',
      '',
      '',
      '1',
      '0',
    ]),
    command: rowNumber === 4 ? null : JSON.stringify(command),
    state: rowNumber === 4 ? 'FAILED' : 'SUCCEEDED',
    errorCode: rowNumber === 4 ? 'INVENTORY_CSV_ROW_INVALID' : null,
    message: rowNumber === 4 ? 'Error while traversing csv data.' : 'Product stock row processed.',
  }));
  return { anchor, metadata, rows };
};
describe('historical inventory import BigQuery contract', () => {
  it('uses bound snapshot/ownership queries and preserves bigint IDs through paging and failure downloads', async () => {
    const data = fixture(),
      calls: {
        query: string;
        params: Record<string, unknown>;
        types: Record<string, string | string[]>;
        resource?: string;
      }[] = [];
    const history = inventoryImportHistory(
      config,
      options,
      {
        async queryReport(query, params, types, resource) {
          calls.push({ query, params, types, resource });
          if (query.includes('record_stats')) return [data.metadata];
          return [...data.rows]
            .reverse()
            .filter(
              (row) =>
                Number(row.rowNumber) > Number(params.after) &&
                (params.allStates || row.state === params.state),
            )
            .slice(0, Number(params.limit));
        },
      },
      now,
    );
    expect(history.enabled).toBe(true);
    expect(await history.detail(data.anchor)).toMatchObject({
      id: data.anchor.id,
      actorId: '9007199254740997',
    });
    const page = await history.rows(data.anchor, { after: 0, state: 'all', limit: 2 });
    expect(page.data.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(page.nextCursor).toBe('3');
    expect(page.data[0]?.command?.productId).toBe('9007199254740999');
    const content = await history.failedCsv(data.anchor);
    let csv = '';
    for await (const chunk of content) csv += chunk;
    expect(csv).toContain("'=HYPERLINK");
    expect(calls[0]?.query).toContain('@importId');
    expect(calls[0]?.query).not.toContain(data.anchor.id);
    expect(calls[0]?.query).not.toContain(data.anchor.actorId);
    expect(calls[0]?.params).toMatchObject({
      importId: data.anchor.id,
      actorId: data.anchor.actorId,
      checksum: 'a'.repeat(64),
      createdAt: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:01:00.000Z',
    });
    expect(calls[0]?.types).toMatchObject({
      actorId: 'STRING',
      createdAt: 'TIMESTAMP',
      updatedAt: 'TIMESTAMP',
    });
    expect(calls.every((call) => call.resource?.startsWith('inventory-import-'))).toBe(true);
  });
  it('keeps the exact24h boundary while binding representable microsecond warehouse cutoffs', async () => {
    const data = fixture(),
      cutoff = Temporal.Instant.from('2026-11-15T00:00:00.000000001Z');
    data.anchor.createdAt = '2026-11-15 00:00:00.000';
    data.anchor.updatedAt = '2026-11-15 00:01:00.000';
    data.metadata.createdAt = '2026-11-15T00:00:00.000Z';
    data.metadata.updatedAt = '2026-11-15T00:01:00.000Z';
    const calls: Record<string, unknown>[] = [];
    const history = inventoryImportHistory(
      config,
      options,
      {
        async queryReport(query, params) {
          calls.push(params);
          return [
            query.includes('record_stats')
              ? data.metadata
              : { ...data.metadata, recordCount: undefined, distinctRecords: undefined },
          ];
        },
      },
      () => cutoff.add({ hours: 24 }),
    );
    expect((await history.detail(data.anchor)).id).toBe(data.anchor.id);
    await history.list(
      { actorId: data.anchor.actorId, allActors: false },
      { from: '2026-11-15', to: '2026-11-15', after: '0', limit: 10 },
    );
    expect(calls.map((call) => call.cutoff)).toEqual([
      '2026-11-15T00:00:00.000001Z',
      '2026-11-15T00:00:00.000001Z',
    ]);
    expect(historicalInventoryImport(data.anchor, cutoff)).toBe(true);
    expect(mysqlImportCutoff(cutoff)).toBe('2026-11-15 00:00:00.001');
    const equal = Temporal.Instant.from('2026-11-15T00:00:00Z');
    expect(historicalInventoryImport(data.anchor, equal)).toBe(false);
    expect(mysqlImportCutoff(equal)).toBe(data.anchor.createdAt);
    for (const value of [
      '2026-11-14T23:59:59.999999Z',
      '2026-11-15T00:00:00Z',
      '2026-11-15T00:00:00.000001Z',
    ]) {
      const row = Temporal.Instant.from(value),
        bound = Temporal.Instant.from(String(calls[0]!.cutoff));
      expect(Temporal.Instant.compare(row, cutoff) < 0).toBe(
        Temporal.Instant.compare(row, bound) < 0,
      );
    }
  });
  it('rejects missing, duplicated, lagging or inconsistent archived snapshots without fallback', async () => {
    for (const change of [
      { recordCount: '2' },
      { distinctRecords: '2' },
      { maximumRecord: '5' },
      { failedCount: '0' },
      { updatedAt: '2026-11-10T00:02:00.000Z' },
      { actorId: '1' },
    ]) {
      const data = fixture();
      const history = inventoryImportHistory(
        config,
        options,
        {
          async queryReport() {
            return [{ ...data.metadata, ...change }];
          },
        },
        now,
      );
      await expect(history.detail(data.anchor)).rejects.toMatchObject({
        code: 'INVENTORY_IMPORT_HISTORY_INVALID',
      });
    }
    const data = fixture();
    const duplicate = inventoryImportHistory(
      config,
      options,
      {
        async queryReport() {
          return [data.metadata, data.metadata];
        },
      },
      now,
    );
    await expect(duplicate.detail(data.anchor)).rejects.toMatchObject({
      code: 'INVENTORY_IMPORT_HISTORY_INVALID',
    });
    expect(() =>
      reduceHistoricalImport({ ...data.metadata, sequence: 9007199254740992 }),
    ).toThrow();
    expect(() =>
      readImportHistoryOptions({
        BQ_INVENTORY_IMPORTS_VIEW: 'fixture-project.data.table` WHERE true --',
      }),
    ).toThrow();
  });
  it('bounds historical list dates/actors/cursors and rejects a provider row outside the requested scope', async () => {
    const data = fixture(),
      second = { ...data.metadata, id: randomUUID(), sequence: '9007199254740991' };
    let calls = 0,
      allActors: unknown;
    const history = inventoryImportHistory(
      config,
      options,
      {
        async queryReport(_query, params) {
          calls++;
          allActors = params.allActors;
          return [second, data.metadata];
        },
      },
      now,
    );
    const input = { from: '2026-11-01', to: '2026-11-14', after: '0', limit: 1 };
    const page = await history.list({ actorId: data.anchor.actorId, allActors: false }, input);
    expect(page.nextCursor).toBe('9007199254740993');
    expect(page.data[0]?.id).toBe(data.anchor.id);
    expect(allActors).toBe(false);
    await expect(history.list({ actorId: '1', allActors: false }, input)).rejects.toMatchObject({
      code: 'INVENTORY_IMPORT_HISTORY_INVALID',
    });
    await expect(
      history.list({ actorId: '1', allActors: true }, { ...input, from: '2026-11-20' }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE' });
    const before = calls;
    expect(
      await history.list(
        { actorId: '1', allActors: true },
        { ...input, from: '2026-11-16', to: '2026-11-16' },
      ),
    ).toMatchObject({ data: [] });
    expect(calls).toBe(before);
  });
  it('keeps missing view configuration gated and validates row identity before returning records', async () => {
    const data = fixture();
    let calls = 0;
    const missing = inventoryImportHistory(
      config,
      readImportHistoryOptions({}),
      {
        async queryReport() {
          calls++;
          return [];
        },
      },
      now,
    );
    await expect(missing.detail(data.anchor)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(calls).toBe(0);
    const corrupt = inventoryImportHistory(
      config,
      options,
      {
        async queryReport(query) {
          return query.includes('record_stats')
            ? [data.metadata]
            : [{ ...data.rows[0]!, importId: randomUUID() }];
        },
      },
      now,
    );
    await expect(
      corrupt.rows(data.anchor, { after: 0, state: 'all', limit: 50 }),
    ).rejects.toMatchObject({ code: 'INVENTORY_IMPORT_HISTORY_INVALID' });
  });
});
