import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../../src/config.js';
import {
  inventoryImportHistory,
  readImportHistoryOptions,
} from '../../../src/modules/administration/import-history.js';
import type { inventoryImports } from '../../../src/modules/administration/import-schema.js';
import {
  parentStoreCells,
  parentStoreCommand,
  parentStoreHeaders,
} from '../../../src/modules/administration/parent-store-imports/domain.js';
import { readParentStoreImportOptions } from '../../../src/modules/administration/parent-store-imports/service.js';
const config = readConfig({
  NODE_ENV: 'test',
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_parent_history',
  SESSION_SECRET: 'parent-history-fixture-'.repeat(3),
  BIGQUERY_PROJECT_ID: 'fixture-project',
});
const options = readImportHistoryOptions({
  BQ_INVENTORY_IMPORTS_VIEW: 'fixture-project.rewrite.parent_store_imports',
  BQ_INVENTORY_IMPORT_ROWS_VIEW: 'fixture-project.rewrite.parent_store_import_rows',
});
const profile = {
  kind: 'parent-store' as const,
  cells: parentStoreCells,
  command: parentStoreCommand,
  headers: parentStoreHeaders,
};
const now = () => Temporal.Instant.from('2026-11-16T00:00:00Z');
function fixture() {
  const anchor: typeof inventoryImports.$inferSelect = {
    id: randomUUID(),
    profile: 'parent-store',
    sequence: 9007199254740993n,
    actorId: '900001',
    requestId: null,
    checksum: 'a'.repeat(64),
    name: 'ParentStore.csv',
    state: 'COMPLETED',
    errorCode: null,
    totalRows: 2,
    processedRows: 2,
    successfulRows: 1,
    failedRows: 1,
    createdAt: '2026-11-10 00:00:00.000',
    updatedAt: '2026-11-10 00:01:00.000',
  };
  const metadata = {
    ...anchor,
    sequence: String(anchor.sequence),
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:01:00.000Z',
    recordCount: 2,
    distinctRecords: 2,
    minimumRecord: 2,
    maximumRecord: 3,
    succeededCount: 1,
    failedCount: 1,
    cancelledCount: 0,
    unexpectedCount: 0,
  };
  const row = {
    profile: 'parent-store',
    importId: anchor.id,
    actorId: anchor.actorId,
    checksum: anchor.checksum,
    updatedAt: metadata.updatedAt,
    rowNumber: 3,
    cells: '["=1","1","1"]',
    command: null,
    state: 'FAILED',
    errorCode: 'PARENT_STORE_CSV_ROW_INVALID',
    message: 'Error while traversing csv data.',
  };
  return { anchor, metadata, row };
}
describe('historical parent/store import publication contract', () => {
  it('binds the separate profile and exact writer snapshot for records/failures and preserves the three-column response', async () => {
    const data = fixture(),
      calls: { query: string; params: Record<string, unknown>; resource?: string }[] = [];
    const history = inventoryImportHistory(
      config,
      options,
      {
        queryReport: async (query, params, _types, resource) => {
          calls.push({ query, params, resource });
          return query.includes('record_stats') ? [data.metadata] : [data.row];
        },
      },
      now,
      profile,
    );
    expect(history.enabled).toBe(true);
    expect(await history.detail(data.anchor)).toMatchObject({ id: data.anchor.id });
    const rows = await history.rows(data.anchor, { after: 0, limit: 50, state: 'FAILED' });
    expect(rows.data[0]?.cells).toEqual(['=1', '1', '1']);
    let csv = '';
    for await (const chunk of await history.failedCsv(data.anchor)) csv += chunk;
    expect(csv).toContain('"SkuId","StoreId","IsActive","Message"');
    expect(csv).toContain("'=1");
    expect(
      calls.every(
        (call) =>
          call.params.profile === 'parent-store' &&
          call.params.importId === data.anchor.id &&
          call.resource?.startsWith('parent-store-import-'),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.query.includes('job_profile=@profile'))).toBe(true);
    expect(calls.some((call) => call.query.includes('i.profile=@profile'))).toBe(true);
    expect(calls.every((call) => !call.query.includes(data.anchor.id))).toBe(true);
  });
  it('refuses stock-profile/partial/stale publications and never falls back to a historical MySQL scan', async () => {
    const data = fixture();
    for (const metadata of [
      { ...data.metadata, profile: 'stock' },
      { ...data.metadata, profile: undefined },
      { ...data.metadata, checksum: 'b'.repeat(64) },
      { ...data.metadata, recordCount: 1 },
    ]) {
      const history = inventoryImportHistory(
        config,
        options,
        { queryReport: async () => [metadata] },
        now,
        profile,
      );
      await expect(history.detail(data.anchor)).rejects.toMatchObject({
        code: 'INVENTORY_IMPORT_HISTORY_INVALID',
      });
    }
    const missing = inventoryImportHistory(
      config,
      readImportHistoryOptions({}),
      {
        queryReport: async () => {
          throw new Error('must not query');
        },
      },
      now,
      profile,
    );
    expect(missing.enabled).toBe(false);
    await expect(missing.detail(data.anchor)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
  it('keeps parent settings independent and validates fully-qualified configured views', () => {
    expect(readParentStoreImportOptions({})).toEqual({});
    expect(() =>
      readParentStoreImportOptions({ BQ_PARENT_STORE_IMPORTS_VIEW: 'bad`view' }),
    ).toThrow();
    expect(
      readParentStoreImportOptions({
        BQ_PARENT_STORE_IMPORTS_VIEW: options.BQ_INVENTORY_IMPORTS_VIEW,
      }).BQ_PARENT_STORE_IMPORTS_VIEW,
    ).toBe(options.BQ_INVENTORY_IMPORTS_VIEW);
  });
});
