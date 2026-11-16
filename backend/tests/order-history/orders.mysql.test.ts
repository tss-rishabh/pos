import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import type { RowDataPacket } from 'mysql2';
import * as orm from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import * as models from '../../src/db/legacy-schema.js';
import * as access from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import type { Databases } from '../../src/db/pools.js';
import { ordersService, type OrdersService } from '../../src/modules/orders.js';
import type { OrderHistoryPort } from '../../src/modules/order-history/contracts.js';
import { orderHistoryFixture } from './mysql-fixture.js';
import { now, header, stores, lines, generation } from './fixtures.js';
const template = process.env.ORDER_HISTORY_MYSQL_TEST_URL;
const actor: access.Principal = {
  id: '1',
  role: 2,
  userType: 1,
  storeIds: ['1'],
  name: 'Synthetic operator',
  email: '',
};
const evidence = {
  generationId: generation,
  sourceSnapshotId: 'synthetic-checkpoint-001',
  sourceSnapshotAt: new Date(now - 60000).toISOString(),
  sourceCdcWatermark: new Date(now - 50000).toISOString(),
  publishedAt: new Date(now - 40000).toISOString(),
};
const priorSource = execFileSync('git', ['show', 'b90b4be:backend/src/modules/orders.ts'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
function pinned(db: Databases): OrdersService {
  const exports: { ordersService?: (db: Databases) => OrdersService } = {};
  const imports: Record<string, unknown> = {
    'drizzle-orm': orm,
    '../db/legacy-schema.js': models,
    '../domain/access.js': access,
    '../domain/errors.js': { AppError },
  };
  vm.runInNewContext(
    ts.transpileModule(priorSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    }).outputText,
    {
      exports,
      require: (name: string) => {
        if (!(name in imports)) throw new Error('Unexpected pinned module import.');
        return imports[name];
      },
    },
  );
  if (!exports.ordersService) throw new Error('Pinned orders oracle missing.');
  return exports.ordersService(db);
}
describe.skipIf(!template)(
  'date-scoped public orders on isolated MySQL and pinned projection',
  () => {
    let native: Awaited<ReturnType<typeof orderHistoryFixture>>,
      db: Databases,
      service: OrdersService;
    let called: string[], historyCalls: string[], onWarehouse: (() => Promise<void>) | undefined;
    const historical: OrderHistoryPort = {
      async list() {
        historyCalls.push('list');
        await onWarehouse?.();
        return { rows: [{ header, store: stores[0]! }], evidence };
      },
      async order() {
        historyCalls.push('order');
        await onWarehouse?.();
        return { header, stores, lines, evidence };
      },
      async copyFacts() {
        throw new Error('Not used by browsing.');
      },
    };
    beforeAll(async () => {
      native = await orderHistoryFixture(template!);
    });
    beforeEach(async () => {
      await native.reset();
      called = [];
      historyCalls = [];
      onWarehouse = undefined;
      db = {
        get(role) {
          called.push(role);
          return native.db.get(role);
        },
        async close() {},
      };
      await native.fixture.insert('pos_user', {
        id: '1',
        username: 'synthetic-operator',
        password: 'synthetic-not-a-password-hash',
        role: 2,
        user_type: 1,
        is_active: 1,
      });
      await native.fixture.insert('user_stores', { id: '1', django_user_id: '1', store_id: '1' });
      await native.fixture.insert('stores', {
        id: '1',
        store_name: 'Synthetic store',
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('order_status', { id: '3', display_name: 'Delivered' });
      await native.fixture.insert('payment_status', { id: '4', payment_status: 'Paid' });
      for (const [id, date] of [
        ['9007199254740993', '2026-11-17 10:00:00'],
        ['9007199254740992', '2026-11-17 09:00:00'],
        ['7', '2026-11-16 08:00:00'],
      ] as const)
        await native.fixture.insert('orders', {
          id,
          user_id: '7',
          order_ref_no: 'SYNTHETIC-' + id,
          first_name: '  Synthetic',
          last_name: 'Customer  ',
          pay_amt: 1234.5,
          order_status: '3',
          payment_status: '4',
          created_at: date,
        });
      for (const [id, order] of [
        ['11', '9007199254740993'],
        ['10', '9007199254740993'],
        ['9', '9007199254740992'],
        ['8', '7'],
      ] as const)
        await native.fixture.insert('order_stores', {
          id,
          order_id: order,
          store_id: '1',
          counter_id: '1',
        });
      await native.fixture.insert('products', {
        id: '101',
        product: 'Synthetic item',
        prod_type: '1',
      });
      for (const [id, product, qty] of [
        ['9007199254741001', '101', '4'],
        ['9007199254741002', '101', '1'],
        ['9007199254741003', '999', '0'],
      ] as const)
        await native.fixture.insert('has_products', {
          id,
          order_id: '9007199254740993',
          prod_id: product,
          sub_prod_id: '0',
          qty,
          price: 10.5,
          gst: 5,
          status: 'DELIVERED',
        });
      service = ordersService(db, native.config, historical, () => now);
    });
    afterAll(async () => {
      await native?.close();
    });
    it('matches the exact pinned baseline projection within current dates, preserving native FLOAT and full-width IDs', async () => {
      const baseline = await pinned(native.db).list(actor, '1', undefined, 100),
        current = await service.list(actor, '1', undefined, 100);
      expect(current.data.map(({ rowId: _row, ...row }) => row)).toEqual(
        baseline.data.filter((row) => row.createdAt >= '2026-11-17 00:00:00'),
      );
      expect(current.reader).toBe('primary');
      expect(historyCalls).toEqual([]);
      const old = await pinned(native.db).detail(actor, '1', '9007199254740993'),
        fresh = await service.detail(actor, '1', '9007199254740993');
      const normalize = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
        ) as unknown;
      const { reader: _reader, range: _range, fetchedAt: _fetched, ...plain } = fresh;
      expect(normalize(plain)).toEqual(normalize(old));
      expect(fresh.lines).toHaveLength(3);
      expect(fresh.lines[2]?.name).toBeNull();
    });
    it('paginates duplicate store associations without skipping a row or converting BIGINT to Number', async () => {
      const pages = [];
      let cursor: string | undefined;
      for (let index = 0; index < 4; index++) {
        const result = await service.list(actor, '1', cursor, 1);
        pages.push(...result.data);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(pages.map((row) => row.rowId)).toEqual(['11', '10', '9']);
      expect(pages.map((row) => row.id)).toEqual([
        '9007199254740993',
        '9007199254740993',
        '9007199254740992',
      ]);
    });
    it('uses DATA only for a current-day background report and never reads old native facts for historical/mixed dates', async () => {
      await service.list(actor, '1', undefined, 30, { intent: 'report' });
      expect(called).toContain('data');
      expect(called).not.toContain('primary');
      called = [];
      const result = await service.list(actor, '1', undefined, 30, {
        from: '2026-11-16',
        to: '2026-11-17',
      });
      expect(result.reader).toBe('bigquery');
      expect(called.every((role) => role === 'writer')).toBe(true);
      expect(historyCalls).toEqual(['list']);
      await service.detail(actor, '1', '7', { from: '2026-11-16', to: '2026-11-16' });
      expect(historyCalls).toEqual(['list', 'order']);
    });
    it('classifies unknown-age links using a today-bounded query then BQ only, with no unrestricted native fallback', async () => {
      const result = await service.detail(actor, '1', '7');
      expect(result.reference).toBe('SYNTHETIC');
      expect(result.reader).toBe('bigquery');
      expect(historyCalls).toEqual(['order']);
      historyCalls = [];
      await expect(
        service.detail(actor, '1', '7', { from: '2026-11-17', to: '2026-11-17' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(historyCalls).toEqual([]);
    });
    it('fails closed on missing history and rechecks native assignment after warehouse work without holding its SQL locks', async () => {
      const unavailable = ordersService(
        db,
        native.config,
        {
          ...historical,
          async list() {
            throw new AppError(
              503,
              'ORDER_HISTORY_PUBLICATION_REQUIRED',
              'Synthetic missing publication',
            );
          },
        },
        () => now,
      );
      await expect(
        unavailable.list(actor, '1', undefined, 30, { from: '2026-11-16', to: '2026-11-16' }),
      ).rejects.toMatchObject({ status: 503 });
      expect(called.every((role) => role === 'writer')).toBe(true);
      onWarehouse = async () => {
        await native.connection.query('DELETE FROM user_stores WHERE django_user_id=1');
      };
      await expect(
        service.list(actor, '1', undefined, 30, { from: '2026-11-16', to: '2026-11-16' }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it('accepts review index candidates on local physical schemas with identical rows and inspectable native plans', async () => {
      const sql =
        'SELECT o.id,os.id AS row_id FROM order_stores os JOIN orders o ON o.id=os.order_id WHERE os.store_id=? AND o.created_at>=? AND o.created_at<? ORDER BY o.id DESC,os.id DESC LIMIT 31';
      const params = ['1', '2026-11-17 00:00:00', '2026-11-18 00:00:00'];
      const [before] = await native.connection.execute<RowDataPacket[]>(sql, params);
      const [beforePlan] = await native.connection.execute<RowDataPacket[]>(
        'EXPLAIN FORMAT=JSON ' + sql,
        params,
      );
      await native.connection.query(
        'CREATE INDEX ix_order_history_created_id ON orders(created_at,id)',
      );
      await native.connection.query(
        'CREATE INDEX ix_order_history_store_order_id ON order_stores(store_id,order_id,id)',
      );
      const [after] = await native.connection.execute<RowDataPacket[]>(sql, params);
      const [afterPlan] = await native.connection.execute<RowDataPacket[]>(
        'EXPLAIN FORMAT=JSON ' + sql,
        params,
      );
      expect(after).toEqual(before);
      expect(before).toHaveLength(3);
      expect(String(beforePlan[0]?.EXPLAIN)).not.toContain('ix_order_history');
      expect(String(afterPlan[0]?.EXPLAIN)).toContain('ix_order_history');
    });
  },
);
