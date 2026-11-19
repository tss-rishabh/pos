import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { catalogDetailsService } from '../../src/modules/catalog-details/service.js';
import { inventoryMatrixService } from '../../src/modules/catalog-details/matrix.js';
import { bindCheckInRedis } from '../../src/modules/administration/checkins.js';
import { memoryRedisPort } from '../helpers/memory-redis.js';
import { createProductionTables } from '../helpers/production-schema.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

/**
 * Pinned catalog page dispatch (78d5b63): ProductsView.get (`core/views.py:703-720`) and
 * ProductsStockView (`core/views.py:177-190`, `user_type_exempt("[2]")`), with
 * Helpers.get_checkin_store (`helpers/helpers.py:1791-1800`), run over this fixture and replayed
 * from `tests/golden/catalog-details/page-dispatch.json`. The datatable halves are covered by
 * mysql.integration.test.ts; the browser half of the former native UI workflow is not captured.
 */
const connection = process.env.MYSQL_INTEGRATION_URL;
const checkInRedis = memoryRedisPort();
bindCheckInRedis(checkInRedis);
interface Actor {
  id: string;
  role: number;
  userType: number;
  storeIds: string[];
  checkIn: string | null;
}
const actors: Actor[] = [
  { id: '11', role: 1, userType: 1, storeIds: [], checkIn: '1' },
  { id: '12', role: 4, userType: 1, storeIds: ['1', '2'], checkIn: '3' },
  { id: '13', role: 4, userType: 2, storeIds: ['2', '5'], checkIn: '5' },
  { id: '14', role: 1, userType: 2, storeIds: ['2'], checkIn: null },
  { id: '15', role: 4, userType: 1, storeIds: ['1'], checkIn: '4' },
];
const cases = [
  ...actors.map((actor) => ({
    page: 'catalog',
    method: 'GET',
    actorId: actor.id,
    storeIds: [],
    checkinStoreId: actor.checkIn,
  })),
  ...actors.map((actor) => ({
    page: 'matrix',
    method: 'GET',
    actorId: actor.id,
    storeIds: [],
    checkinStoreId: actor.checkIn,
  })),
  { page: 'catalog', method: 'GET', actorId: null, storeIds: [], checkinStoreId: null },
];
const legacySchema = z.array(
  z
    .object({
      kind: z.literal('page'),
      status: z.number(),
      context: z
        .object({
          stores: z.array(z.object({ id: z.string(), name: z.string() })),
          selectedStoreIds: z.array(z.string()),
        })
        .nullable(),
      htmlSha256: z.string().nullable(),
    })
    .strict(),
);
const principal = (actor: Actor): Principal => ({
  id: actor.id,
  name: 'Synthetic operator ' + actor.id,
  email: '',
  role: actor.role,
  userType: actor.userType,
  storeIds: actor.storeIds,
});
const sorted = (values: string[]) => [...values].sort((a, b) => Number(a) - Number(b));

describe.skipIf(!connection)('pinned catalog page dispatch against the rewrite on MySQL', () => {
  const schema = 'pos_rewrite_catalog_workflow_' + randomBytes(6).toString('hex');
  let admin: mysql.Connection | undefined, databases: Databases | undefined;
  let legacy: z.infer<typeof legacySchema>;
  const config = readConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'catalog-page-dispatch-local-'.repeat(3),
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    BUSINESS_TIMEZONE: 'Asia/Kolkata',
  });
  beforeAll(async () => {
    const base = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(base.hostname))
      throw new Error('Catalog fixtures require a local MySQL host.');
    admin = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await admin.changeUser({ database: schema });
    await createProductionTables(admin, [
      'stores',
      'pos_user',
      'user_stores',
      'products',
      'product_store',
    ]);
    for (const [id, name, type, active] of [
      [1, 'Bravo store', 'STORE', 1],
      [2, 'Alpha store', 'STORE', 1],
      [3, 'Core warehouse', 'CORE_WAREHOUSE', 1],
      [4, 'Closed store', 'STORE', 0],
      [5, 'Charlie store', 'STORE', 1],
    ] as const)
      await admin.query(
        "INSERT INTO stores (id,store_name,phone,type,is_active,location_code,category) VALUES (?,?,?,?,?,?,'IN_HOUSE')",
        [id, name, '90000002' + String(id).padStart(2, '0'), type, active, 'L' + id],
      );
    let link = 0;
    for (const actor of actors) {
      await admin.query(
        "INSERT INTO pos_user (id,username,password,email,is_active,role,user_type) VALUES (?,?,'unused',?,1,?,?)",
        [
          actor.id,
          'operator' + actor.id,
          'operator' + actor.id + '@example.invalid',
          actor.role,
          actor.userType,
        ],
      );
      for (const store of actor.storeIds)
        await admin.query('INSERT INTO user_stores (id,django_user_id,store_id) VALUES (?,?,?)', [
          ++link,
          actor.id,
          store,
        ]);
    }
    base.pathname = '/' + schema;
    const url = base.href;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'catalog-page-dispatch-local-'.repeat(3),
        MYSQL_WRITER_URL: url,
        MYSQL_PRIMARY_READER_URL: url,
        MYSQL_DATA_READER_URL: url,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
    );
    legacy = legacySchema.parse(
      JSON.parse(
        goldenStdout(
          'catalog-details',
          'page-dispatch',
          JSON.stringify({ url, cases }),
          undefined,
          fixturePlaceholders(url),
        ),
      ) as unknown,
    );
    expect(legacy).toHaveLength(cases.length);
  });
  afterAll(async () => {
    await databases?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await admin?.end();
  });

  it('lists the same catalog stores and preselects the same checked-in store as ProductsView', async () => {
    const catalog = catalogDetailsService(config, databases!);
    for (const [index, actor] of actors.entries()) {
      const source = legacy[index]!;
      expect(source.status, actor.id).toBe(200);
      if (actor.checkIn) await checkInRedis.set(`check_in_${actor.id}`, `[${actor.checkIn}, "x"]`);
      else await checkInRedis.del(`check_in_${actor.id}`);
      const actual = await catalog.metadata(principal(actor));
      // Legacy iterates an unordered Store queryset (primary-key order); the rewrite lists
      // stores by name. Membership and selection are compared; order is a presentation change.
      const expectedStores =
        actor.role === 1 && actor.userType === 2
          ? // S45: a franchise account stays scoped to its assigned stores even with role 1;
            // legacy (`role != 1 and user_type == 2`) shows every active store.
            source.context!.stores.filter((store) => actor.storeIds.includes(store.id))
          : source.context!.stores;
      if (actor.role === 1 && actor.userType === 2)
        expect(source.context!.stores.length).toBeGreaterThan(expectedStores.length);
      expect(sorted(actual.data.map((store) => store.id)), actor.id).toEqual(
        sorted(expectedStores.map((store) => store.id)),
      );
      expect(actual.data.map((store) => [store.id, store.name]).sort(), actor.id).toEqual(
        expectedStores.map((store) => [store.id, store.name]).sort(),
      );
      expect(actual.selectedStoreIds, actor.id).toEqual(source.context!.selectedStoreIds);
    }
    // Anonymous: LoginRequiredMixin redirects; the rewrite route answers 401 (S4).
    expect(legacy[cases.length - 1]).toMatchObject({ status: 302, context: null });
  });

  it('scopes the stock matrix to the ProductsStockView stores and refuses franchise accounts', async () => {
    const matrix = inventoryMatrixService(databases!);
    for (const [offset, actor] of actors.entries()) {
      const source = legacy[actors.length + offset]!;
      if (actor.userType === 2) {
        // user_type_exempt("[2]") redirects to shortcut_dashboard; the rewrite refuses with 403.
        expect(source, actor.id).toMatchObject({ status: 302, context: null });
        await expect(
          matrix.search(principal(actor), { storeIds: [] }),
          actor.id,
        ).rejects.toMatchObject({ status: 403, code: 'INVENTORY_ADMINISTRATION_DENIED' });
        continue;
      }
      expect(source.status, actor.id).toBe(200);
      const actual = await matrix.search(principal(actor), { storeIds: [] });
      expect(sorted(actual.stores.map((store) => store.id)), actor.id).toEqual(
        sorted(source.context!.stores.map((store) => store.id)),
      );
    }
  });
});
