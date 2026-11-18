import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { normalizedExportInput } from '../../src/modules/operational-reports/export-domain.js';
import { reportExportBuilder } from '../../src/modules/operational-reports/export-service.js';
import { collectionExportScope } from '../../src/modules/administration/collection-export.js';

const user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 3,
    userType: 1,
    storeIds: ['1'],
  },
  input = {
    kind: 'administration-list',
    resource: 'operators',
    storeIds: [],
    search: 'private fixture',
    active: 'all',
    sort: 'name',
    direction: 'desc',
    columns: ['name', 'role'],
  };
describe('date-free administration export integration', () => {
  it('keeps current collection scope distinct from historical date filters', () => {
    expect(normalizedExportInput(input)).toEqual(input);
    expect(() => normalizedExportInput({ ...input, from: '2026-11-01' })).toThrow();
    expect(() => normalizedExportInput({ ...input, columns: ['password'] })).toThrow();
    expect(() => normalizedExportInput({ ...input, sort: 'name; DROP TABLE pos_user' })).toThrow();
    const stores = normalizedExportInput({ ...input, resource: 'stores', columns: ['name'] });
    if (stores.kind !== 'administration-list') throw new Error('Expected collection');
    expect(collectionExportScope({ ...user, role: 1, storeIds: [] }, stores)).toEqual({
      storeIds: [],
      requiresGlobal: true,
    });
    expect(collectionExportScope(user, stores)).toEqual({ storeIds: ['1'], requiresGlobal: false });
  });
  it('dispatches the exact bounded collection renderer without entering report/date or warehouse readers', async () => {
    let calls = 0;
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'admin-export-fixture-'.repeat(3),
      }),
      db: Databases = {
        get() {
          throw new Error('Unexpected financial or warehouse reader');
        },
        close: async () => {},
      },
      build = reportExportBuilder(config, db, {
        administration: async (actor, selected, context) => {
          calls++;
          expect(actor).toBe(user);
          expect(selected).toEqual(input);
          expect(context?.maxBytes).toBe(1000);
          return {
            bytes: Buffer.from('"Name","Role"\r\n"Fixture","3"'),
            rowCount: 1,
            format: 'CSV',
          };
        },
      }),
      artifact = await build(user, normalizedExportInput(input), {
        jobId: 'fixture',
        signal: new AbortController().signal,
        maxBytes: 1000,
      });
    expect(calls).toBe(1);
    expect(artifact).toMatchObject({ rowCount: 1, format: 'CSV' });
  });
});
