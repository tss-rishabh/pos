import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { Principal } from '../../src/api/types';
import { db } from '../../src/offline/database';
import {
  clearCatalogSnapshots,
  loadCatalogSnapshot,
  saveCatalogSnapshot,
} from '../../src/pages/catalog/snapshot-cache';
import { filterCatalogSnapshot } from '../../src/pages/catalog/snapshot-filter';
import type { SnapshotRow } from '../../src/pages/catalog/contracts';
const user: Principal = {
  id: '1',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
const snapshot = {
  reader: 'primary',
  store: { id: '1', name: 'Fixture store' },
  syncedAt: '2026-11-16T09:00:00Z',
  data: [['9007199254740993', 'Fixture blue', '9007199254740994', '10.00', '8.00', 7, 3]],
};
describe('permission and session scoped offline product catalogs', () => {
  beforeEach(async () => {
    await db.sessions.clear();
    await clearCatalogSnapshots();
  });
  afterEach(() => vi.restoreAllMocks());
  it('isolates users, role/type/assignment changes and expires with the cached login', async () => {
    const now = Date.now();
    await db.sessions.put({ id: 'current', user, expiresAt: now + 60000 });
    await saveCatalogSnapshot(user, '1', snapshot);
    expect((await loadCatalogSnapshot(user, '1'))?.data[0]?.[0]).toBe('9007199254740993');
    expect(await loadCatalogSnapshot({ ...user, id: '2' }, '1')).toBeNull();
    expect(await loadCatalogSnapshot({ ...user, role: 2 }, '1')).toBeNull();
    expect(await loadCatalogSnapshot({ ...user, userType: 2 }, '1')).toBeNull();
    expect(await loadCatalogSnapshot({ ...user, storeIds: ['1'] }, '1')).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60001);
    expect(await loadCatalogSnapshot(user, '1')).toBeNull();
  });
  it('does not cache without a live owner session and clears owned snapshots on logout', async () => {
    await saveCatalogSnapshot(user, '1', snapshot);
    expect(await loadCatalogSnapshot(user, '1')).toBeNull();
    await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 100000 });
    await saveCatalogSnapshot(user, '1', snapshot);
    await clearCatalogSnapshots(user.id);
    expect(await loadCatalogSnapshot(user, '1')).toBeNull();
  });
  it('matches the actual shipped DataTables smart-search function for phrases, metacharacters and newlines', () => {
    const source = readFileSync(
        new URL(
          '../../../../backend-pos-web/static/adminlte/plugins/datatables/jquery.dataTables.js',
          import.meta.url,
        ),
        'utf8',
      ),
      start = source.indexOf('function _fnFilterCreateSearch'),
      end = source.indexOf('\n\t}', start) + 4,
      escapeStart = source.indexOf('_re_escape_regex =') + '_re_escape_regex ='.length,
      escapeEnd = source.indexOf(';', escapeStart);
    const create: unknown = runInNewContext(
      `(function(){var _re_escape_regex=${source.slice(escapeStart, escapeEnd)};function _fnEscapeRegex(val){return val.replace(_re_escape_regex,'\\\\$1');}${source.slice(start, end)};return function(query){return _fnFilterCreateSearch(query,false,true,true).source;};})()`,
      { $: { map: (items: string[], map: (value: string) => string) => items.map(map) } },
    );
    if (typeof create !== 'function') throw new Error('Source filter unavailable.');
    const rows: SnapshotRow[] = [
      ['1', 'blue cotton', '123', '1.00', '0.00', 0, 1],
      ['2', 'cotton blue', '456', '2.00', '0.00', 0, 0],
      ['3', 'literal a+b [x]\nvalue', '789', '3.00', '0.00', 0, 2],
    ];
    for (const query of [
      'cotton blue',
      '"blue cotton"',
      '"cotton blue"',
      'a+b',
      '[x]',
      '^not-a-regex$',
      '1.00 123',
      'value',
      '',
    ]) {
      const pattern: unknown = Reflect.apply(create, undefined, [query]);
      if (typeof pattern !== 'string') throw new Error('Source filter unavailable.');
      expect(filterCatalogSnapshot(rows, query)).toEqual(
        rows.filter((row) =>
          new RegExp(pattern, 'i').test(row.join('  ').replace(/[\r\n\u2028]/g, '')),
        ),
      );
    }
  });
});
