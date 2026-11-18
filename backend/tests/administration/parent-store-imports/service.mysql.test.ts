import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../../src/domain/access.js';
import { AppError } from '../../../src/domain/errors.js';
import { ProductStore } from '../../../src/db/legacy-schema.js';
import {
  parentStoreImportService,
  registerParentStoreImports,
} from '../../../src/modules/administration/parent-store-imports/index.js';
import { inventoryImportService } from '../../../src/modules/administration/imports.js';
import { inventoryService } from '../../../src/modules/administration/inventory.js';
import {
  administrationWorker,
  type AdministrationWorkerEvent,
} from '../../../src/modules/administration/worker.js';
import { readAdministrationWorkerOptions } from '../../../src/modules/administration/worker-options.js';
import type {
  StockProcedure,
  StockProcedureInput,
} from '../../../src/modules/administration/stock-procedure.js';
import { parentStoreFixture } from '../../../tools/administration/parent-store-imports/fixture.js';
import { goldenSpawnResult } from '../../golden/load.js';
import { fixturePlaceholders } from '../../golden/fixture-placeholders.js';

const connection = process.env.PARENT_STORE_IMPORTS_MYSQL_TEST_URL;
const user: Principal = {
  id: '900001',
  name: 'Synthetic owner',
  email: 'fixture@example.invalid',
  role: 1,
  userType: 1,
  storeIds: [],
};
const rowState = z.object({
  store_id: z.string(),
  product_id: z.string(),
  stock: z.number(),
  is_avail: z.boolean(),
  is_del: z.boolean(),
});
const resultSchema = z.object({
  state: z.array(rowState),
  calls: z.array(
    z.object({
      storeId: z.string(),
      productId: z.string(),
      stock: z.number(),
      userId: z.string(),
      operatorId: z.string(),
      comment: z.string(),
    }),
  ),
  deliveries: z.array(z.object({ product_id_list: z.array(z.number()) })),
  failed: z.array(z.object({ data: z.record(z.string(), z.string()), message: z.string() })),
  imported: z.number(),
  message: z.string(),
  error: z.string().nullable(),
});

describe.skipIf(!connection)(
  'parent/store source-task port on isolated physical-schema MySQL',
  () => {
    let fixture: Awaited<ReturnType<typeof parentStoreFixture>>,
      service: ReturnType<typeof parentStoreImportService>;
    const projections: StockProcedureInput[] = [];
    const projection: StockProcedure = async (tx, input) => {
      projections.push(input);
      await tx
        .update(ProductStore)
        .set({ stock: input.stock })
        .where(
          and(
            eq(ProductStore.store, BigInt(input.storeId)),
            eq(ProductStore.product, BigInt(input.productId)),
          ),
        );
    };
    const options = () => ({
      syncProducts: async () => {},
      procedureVerified: true,
      stockProcedure: projection,
    });
    beforeAll(async () => {
      fixture = await parentStoreFixture(connection!);
      service = parentStoreImportService(fixture.config, fixture.db, options());
    }, 20000);
    beforeEach(async () => {
      await fixture.reset();
      projections.length = 0;
    });
    afterAll(async () => {
      await fixture?.close();
    });
    const csv = (records: string) => 'SkuId,StoreId,IsActive\r\n' + records;
    async function run(records: string, actor = user, instance = service) {
      const input = { id: randomUUID(), name: 'ParentStore.csv', csv: csv(records) };
      await instance.create(actor, input);
      for (let i = 0; i < 20; i++) if (!(await instance.dispatchNext())) break;
      return {
        input,
        job: await instance.detail(actor, input.id),
        rows: await instance.rows(actor, input.id, { after: 0, state: 'all', limit: 100 }),
      };
    }
    async function state() {
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT CAST(store_id AS CHAR) AS store_id,CAST(product_id AS CHAR) AS product_id,stock,is_avail,is_del FROM product_store ORDER BY store_id,product_id',
      );
      return rows.map((row) =>
        rowState.parse({ ...row, is_avail: Boolean(row.is_avail), is_del: Boolean(row.is_del) }),
      );
    }
    async function count(table: string) {
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM ' + table,
      );
      return Number(rows[0]?.n);
    }
    async function oracle(
      records: string,
      extra: { operatorId?: string; role?: number; failProjection?: boolean } = {},
    ) {
      const result = goldenSpawnResult(
        'administration',
        'parent-store-imports-service-mysql',
        JSON.stringify({ database: fixture.url, csv: csv(records), ...extra }),
        undefined,
        fixturePlaceholders(fixture.url),
      );
      if (result.status !== 0)
        throw new Error('Parent/store source oracle failed: ' + result.stdout.slice(0, 200));
      return resultSchema.parse(JSON.parse(result.stdout) as unknown);
    }
    it('matches pinned task family selection, zero/default flags, failures, global parent sync and untouched held stock', async () => {
      const records = '10,1,1\n20,1,0\n30,1,1\n11,1,1\n20,4,1\n20,999,1\n0,1,1\n';
      const source = await oracle(records);
      expect(source.error).toBeNull();
      expect(source.imported).toBe(1);
      await fixture.reset();
      const result = await run(records);
      expect(await state()).toEqual(source.state);
      expect(
        result.rows.data
          .filter((row) => row.state === 'FAILED')
          .map((row) => ({
            data: Object.fromEntries(
              ['SkuId', 'StoreId', 'IsActive'].map((key, i) => [key, row.cells[i]]),
            ),
            message: row.message,
          })),
      ).toEqual(source.failed);
      expect(projections.map((row) => ({ ...row, userId: '0' }))).toEqual(source.calls);
      expect(result.job).toMatchObject({ state: 'COMPLETED', successfulRows: 3, failedRows: 4 });
      const delivered: string[][] = [];
      await inventoryService(fixture.config, fixture.db, {
        syncCatalogProducts: async (_id, ids, context) => {
          expect(context).toMatchObject({ operatorId: user.id, importId: result.input.id });
          expect('storeId' in context).toBe(false);
          delivered.push(ids);
        },
      }).dispatchPending();
      expect(delivered).toEqual(source.deliveries.map((row) => row.product_id_list.map(String)));
      const [held] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT stock FROM hold_stock_store',
      );
      expect(held[0]?.stock).toBe(3);
      const [audit] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT before_json,after_ids,reset_ids FROM pos_rewrite_parent_store_import_audits WHERE record_number=2',
      );
      expect(audit[0]?.before_json).toHaveLength(3);
      expect(audit[0]?.after_ids).toEqual(['10', '11', '12']);
      expect(audit[0]?.reset_ids).toEqual(['11', '12']);
    }, 30000);
    it('preserves source dynamic live variants across ordered distinct stores, including deleted children with positive stock anywhere', async () => {
      const records = '10,2,1\n10,1,1\n';
      const source = await oracle(records);
      await fixture.reset();
      await run(records);
      expect(await state()).toEqual(source.state);
      expect(source.deliveries).toEqual([{ product_id_list: [10, 10] }]);
      const [outbox] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT payload FROM pos_rewrite_administration_outbox',
      );
      expect(outbox[0]?.payload.productIds).toEqual(['10', '10']);
    }, 30000);
    it('uses source store→parent→assignment failure priority for allowed role4/5 operators', async () => {
      const records = '999,999,1\n11,3,1\n20,3,1\n20,1,1\n';
      const source = await oracle(records, { operatorId: '900002', role: 4 });
      await fixture.reset();
      const actor = { ...user, id: '900002', role: 4 as const, storeIds: ['1', '2'] };
      const result = await run(records, actor);
      expect(
        result.rows.data.filter((row) => row.state === 'FAILED').map((row) => row.message),
      ).toEqual(source.failed.map((row) => row.message));
      expect(await state()).toEqual(source.state);
      const five = { ...actor, id: '900003', role: 5 as const };
      expect((await service.capabilities(five)).stores.map((row) => row.id)).toEqual(['1', '2']);
    }, 30000);
    it('rechecks writer-current franchise assignment/category and active identity before processing, independent of cached role1 claims', async () => {
      const actor = { ...user, id: '900004', userType: 2 as const };
      const preview = await service.preview(actor, {
        id: randomUUID(),
        name: 'Parent.csv',
        csv: csv('20,1,1\n30,2,1\n20,3,1\n'),
      });
      expect(preview.rows.map((row) => row.errorCode)).toEqual([
        null,
        'STORE_ACCESS_DENIED',
        'STORE_ACCESS_DENIED',
      ]);
      expect((await service.capabilities(actor)).stores.map((row) => row.id)).toEqual(['1']);
      const input = { id: randomUUID(), name: 'Parent.csv', csv: csv('20,1,1\n') };
      await service.create(actor, input);
      await fixture.admin.query("DELETE FROM user_stores WHERE django_user_id='900004'");
      expect(await service.dispatchNext()).toMatchObject({
        status: 'row-failed',
        errorCode: 'STORE_ACCESS_DENIED',
      });
      expect(projections).toEqual([]);
      await fixture.admin.query("UPDATE pos_user SET is_active=0 WHERE id='900004'");
      await expect(service.detail(actor, input.id)).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      });
    });
    it('blocks and rolls back the entire row family when projection fails after a prior reset', async () => {
      const before = await state();
      let attempts = 0;
      const instance = parentStoreImportService(fixture.config, fixture.db, {
        ...options(),
        stockProcedure: async (tx, input) => {
          await projection(tx, input);
          if (++attempts === 2)
            throw new AppError(503, 'STOCK_PROJECTION_UNAVAILABLE', 'Unavailable.');
        },
      });
      const result = await run('10,1,1\n', user, instance);
      expect(result.job.state).toBe('BLOCKED');
      expect(await state()).toEqual(before);
      expect(await count('pos_rewrite_parent_store_import_audits')).toBe(0);
      expect(await count('pos_rewrite_administration_outbox')).toBe(0);
      expect(result.rows.data[0]?.state).toBe('PENDING');
      await service.control(user, result.input.id, 'resume');
      await service.dispatchNext();
      expect((await service.detail(user, result.input.id)).state).toBe('COMPLETED');
      expect(await count('pos_rewrite_parent_store_import_audits')).toBe(1);
    });
    it('makes the unsafe swallowed-source-routine failure concrete, while candidate refuses partial delete/reinsert', async () => {
      const source = await oracle('20,1,0\n', { failProjection: true });
      expect(source.error).toBeNull();
      expect(source.state.some((row) => row.product_id === '20' && row.store_id === '1')).toBe(
        false,
      );
      await fixture.reset();
      const before = await state();
      const instance = parentStoreImportService(fixture.config, fixture.db, {
        ...options(),
        stockProcedure: async () => {
          throw new AppError(503, 'STOCK_UNAVAILABLE', 'Unavailable.');
        },
      });
      expect((await run('20,1,0\n', user, instance)).job.state).toBe('BLOCKED');
      expect(await state()).toEqual(before);
    }, 30000);
    it('records the delayed source duplicate insert failure and safely refuses both duplicate destructive commands', async () => {
      const source = await oracle('20,1,1\n20,1,1\n');
      expect(source.error).toBe('IntegrityError');
      expect(source.imported).toBe(0);
      expect(source.state.some((row) => row.product_id === '20' && row.store_id === '1')).toBe(
        false,
      );
      await fixture.reset();
      const before = await state(),
        result = await run('20,1,1\n20,1,1\n');
      expect(result.job).toMatchObject({ state: 'COMPLETED', successfulRows: 0, failedRows: 2 });
      expect(await state()).toEqual(before);
      expect(projections).toEqual([]);
      const sourceMixed = await oracle('20,1,1\n20,1,0\n');
      expect(sourceMixed.state.some((row) => row.product_id === '20' && row.store_id === '1')).toBe(
        true,
      );
    }, 30000);
    it('rolls back reset/deletion/recreation when immutable row audit cannot be saved', async () => {
      const before = await state();
      await fixture.admin.query(
        "CREATE TRIGGER reject_parent_audit BEFORE INSERT ON pos_rewrite_parent_store_import_audits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic audit failure'",
      );
      const result = await run('20,1,0\n');
      expect(result.job.state).toBe('BLOCKED');
      expect(await state()).toEqual(before);
      expect(await count('pos_rewrite_administration_outbox')).toBe(0);
    });
    it('deduplicates twenty original UUID creates and concurrent workers; keeps stock and parent queues isolated', async () => {
      const input = { id: randomUUID(), name: 'Parent.csv', csv: csv('20,1,1\n') };
      const replies = await Promise.all(
        Array.from({ length: 20 }, () => service.create(user, input)),
      );
      expect(new Set(replies.map((row) => row.id)).size).toBe(1);
      const stock = inventoryImportService(fixture.config, fixture.db, options());
      expect((await stock.list(user, { after: '0', limit: 50 })).data).toEqual([]);
      await expect(stock.detail(user, input.id)).rejects.toMatchObject({
        code: 'INVENTORY_IMPORT_NOT_FOUND',
      });
      await expect(
        stock.create(user, {
          ...input,
          csv: 'SkuId,StoreId,IsHold,Hold/UnholdQty,IsAvailable,IsDelete\n20,1,,,1,0\n',
        }),
      ).rejects.toMatchObject({ code: 'INVENTORY_IMPORT_ID_REUSED' });
      const results = await Promise.all(Array.from({ length: 10 }, () => service.dispatchNext()));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(projections).toHaveLength(1);
      expect(await count('pos_rewrite_parent_store_import_audits')).toBe(1);
      expect(await count('pos_rewrite_administration_outbox')).toBe(1);
      await expect(service.create(user, { ...input, csv: csv('20,1,0\n') })).rejects.toMatchObject({
        code: 'INVENTORY_IMPORT_ID_REUSED',
      });
    });
    it('synchronizes only committed rows on cancel and preserves lossless generated association/audit IDs', async () => {
      await fixture.admin.query('ALTER TABLE product_store AUTO_INCREMENT=9007199254740993');
      const input = {
        id: randomUUID(),
        name: 'Parent.csv',
        csv: csv('9007199254740993,1,1\n20,2,0\n'),
      };
      await service.create(user, input);
      await service.dispatchNext();
      await service.control(user, input.id, 'cancel');
      const rows = await service.rows(user, input.id, { after: 0, state: 'all', limit: 50 });
      expect(rows.data.map((row) => row.state)).toEqual(['SUCCEEDED', 'CANCELLED']);
      const [outbox] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT payload FROM pos_rewrite_administration_outbox',
      );
      expect(outbox[0]?.payload.productIds).toEqual(['9007199254740993']);
      const [created] = await fixture.admin.query<RowDataPacket[]>(
        "SELECT CAST(id AS CHAR) AS id FROM product_store WHERE product_id='9007199254740993'",
      );
      expect(BigInt(String(created[0]?.id))).toBeGreaterThanOrEqual(9007199254740993n);
    });
    it('runs both import profiles and global synchronization in the existing bounded worker with explicit atomic projection', async () => {
      const parent = { id: randomUUID(), name: 'Parent.csv', csv: csv('20,1,1\n') };
      await service.create(user, parent);
      await fixture.seed('product_store', {
        store_id: '2',
        product_id: '20',
        stock: 8,
        is_avail: 1,
        is_del: 0,
      });
      const stock = inventoryImportService(fixture.config, fixture.db, options()),
        stockInput = {
          id: randomUUID(),
          name: 'Hold.csv',
          csv: 'SkuId,StoreId,IsHold,Hold/UnholdQty,IsAvailable,IsDelete\n20,2,1,2,,\n',
        };
      await stock.create(user, stockInput);
      const events: AdministrationWorkerEvent[] = [],
        bodies: string[] = [],
        worker = administrationWorker(
          fixture.config,
          fixture.db,
          readAdministrationWorkerOptions({
            ADMINISTRATION_WORKER_ENABLED: 'true',
            PRODUCT_SYNC_REPLAY_SAFE: 'true',
            PRODUCT_SYNC_BASE_URL: 'https://fixture.invalid/',
            PRODUCT_SYNC_URI: 'products/sync',
          }),
          (_level, event) => events.push(event),
          async (_url, init) => {
            bodies.push(String(init?.body));
            return new Response(null, { status: 200 });
          },
          { stockProcedure: projection },
        );
      await Promise.all([worker.runOnce(), worker.runOnce()]);
      await worker.stop();
      expect((await service.detail(user, parent.id)).state).toBe('COMPLETED');
      expect(bodies).toEqual(['{"product_id_list":[20]}', '{"product_id_list":[20]}']);
      expect((await stock.detail(user, stockInput.id)).state).toBe('COMPLETED');
      expect(
        projections.some((row) => row.storeId === '2' && row.productId === '20' && row.stock === 6),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.resource === 'parent-store-import' && event.importId === parent.id,
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain('Parent.csv');
      expect(JSON.stringify(events)).not.toContain('fixture@example');
    });
    it('refuses parent imports without explicit atomic projection and never falls back to the opaque CALL', async () => {
      const instance = parentStoreImportService(fixture.config, fixture.db, {
        syncProducts: async () => {},
        procedureVerified: true,
      });
      const input = { id: randomUUID(), name: 'Parent.csv', csv: csv('20,1,1\n') };
      expect((await instance.preview(user, input)).canSubmit).toBe(false);
      await expect(instance.create(user, input)).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
      });
    });
    it('preserves the full role/type matrix while limiting every franchise role to its assigned active franchise stores', async () => {
      for (const type of [1, 2] as const)
        for (const role of [1, 2, 3, 4, 5] as const) {
          await fixture.admin.query('UPDATE pos_user SET role=?,user_type=? WHERE id=900004', [
            role,
            type,
          ]);
          const actor = { ...user, id: '900004', role, userType: type };
          const capabilities = await service.capabilities(actor);
          expect(capabilities.stores.map((row) => row.id)).toEqual(
            type === 2 ? ['1'] : role === 1 ? ['1', '2', '3'] : ['1', '2'],
          );
        }
    });
    it('rechecks archived stores and parent classification on the writer rather than trusting preview', async () => {
      const input = { id: randomUUID(), name: 'Parent.csv', csv: csv('20,1,1\n30,2,1\n') };
      await service.create(user, input);
      await fixture.admin.query('UPDATE stores SET is_active=0 WHERE id=1');
      await fixture.admin.query('UPDATE products SET parent_prod_id=10 WHERE id=30');
      expect(await service.dispatchNext()).toMatchObject({
        status: 'row-failed',
        errorCode: 'STORE_NOT_FOUND',
      });
      expect(await service.dispatchNext()).toMatchObject({
        status: 'row-failed',
        errorCode: 'PARENT_STORE_PARENT_REQUIRED',
      });
      expect(projections).toEqual([]);
      expect(await count('pos_rewrite_parent_store_import_audits')).toBe(0);
    });
    it('synchronizes prior committed rows on a later block, then idempotently resumes the unfinished row without resetting the first twice', async () => {
      let unavailable = true;
      const instance = parentStoreImportService(fixture.config, fixture.db, {
        ...options(),
        stockProcedure: async (tx, input) => {
          if (input.productId === '11' && unavailable)
            throw new AppError(503, 'STOCK_UNAVAILABLE', 'Unavailable.');
          await projection(tx, input);
        },
      });
      const result = await run('20,1,1\n10,1,0\n', user, instance);
      expect(result.job).toMatchObject({ state: 'BLOCKED', successfulRows: 1 });
      let delivered: string[][] = [];
      const delivery = inventoryService(fixture.config, fixture.db, {
        syncCatalogProducts: async (_id, ids) => {
          delivered.push(ids);
        },
      });
      await delivery.dispatchPending();
      expect(delivered).toEqual([['20']]);
      await instance.control(user, result.input.id, 'resume');
      unavailable = false;
      await instance.dispatchNext();
      await delivery.dispatchPending();
      expect(delivered).toEqual([['20'], ['20', '10']]);
      expect(projections.filter((row) => row.productId === '20')).toHaveLength(1);
      expect(await count('pos_rewrite_parent_store_import_audits')).toBe(2);
      delivered = [];
      await delivery.dispatchPending();
      expect(delivered).toEqual([]);
    });
    it('registers traced strict resources and streams the source-compatible template/failures without accepting extra fields', async () => {
      const app = Fastify();
      app.decorateRequest('principal', null);
      app.addHook('preHandler', async (request) => {
        request.principal = user;
      });
      app.setErrorHandler((error, _req, reply) =>
        reply
          .code(error instanceof AppError ? error.status : 400)
          .send({ error: { code: error instanceof AppError ? error.code : 'INVALID_REQUEST' } }),
      );
      const traces: unknown[] = [];
      app.addHook('onRoute', (route) => {
        traces.push(route.config?.trace);
      });
      registerParentStoreImports(app, fixture.config, fixture.db, options());
      try {
        expect(
          (await app.inject({ url: '/api/v1/admin/parent-store-imports/template' })).body,
        ).toContain('"SkuId","StoreId","IsActive"');
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/parent-store-imports',
              payload: { id: randomUUID(), name: 'x.csv', csv: csv('20,1,1\n'), extra: true },
            })
          ).statusCode,
        ).toBe(400);
        const result = await run('=1,1,1\n');
        const reply = await app.inject({
          url: `/api/v1/admin/parent-store-imports/${result.input.id}/failures.csv`,
        });
        expect(reply.body).toContain("'=1");
        expect(reply.headers['cache-control']).toBe('private, no-store');
        expect(
          traces.every(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              'resource' in value &&
              value.resource === 'parent-store-import',
          ),
        ).toBe(true);
      } finally {
        await app.close();
      }
    });
  },
);
