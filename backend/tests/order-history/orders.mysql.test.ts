import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import * as models from '../../src/db/legacy-schema.js';
import * as access from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import type { Databases } from '../../src/db/pools.js';
import { ordersService, type OrdersService } from '../../src/modules/orders.js';
import { orderHistoryFixture } from './mysql-fixture.js';
import { now } from './fixtures.js';
import { seedCheckIn } from '../helpers/check-ins.js';
const template = process.env.ORDER_HISTORY_MYSQL_TEST_URL;
const actor: access.Principal = {
  id: '1',
  role: 2,
  userType: 1,
  storeIds: ['1'],
  name: 'Synthetic operator',
  email: '',
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
    let called: string[];
    beforeAll(async () => {
      native = await orderHistoryFixture(template!);
    });
    beforeEach(async () => {
      await native.reset();
      called = [];
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
      // Check-ins live in the legacy Redis keys (check_in_{uid}).
      await seedCheckIn('1', '1');
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
      service = ordersService(db, native.config, () => now);
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
      const old = await pinned(native.db).detail(actor, '1', '9007199254740993'),
        fresh = await service.detail(actor, '1', '9007199254740993');
      const normalize = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
        ) as Record<string, unknown>;
      const prior = normalize(old);
      expect(normalize(fresh)).toMatchObject({
        id: prior.id,
        reference: prior.reference,
        amount: prior.amount,
        createdAt: prior.createdAt,
        status: prior.status,
        isPaid: prior.isPaid,
      });
      expect(
        fresh.lines.map(({ id, productId, name, quantity, amount, gst, status }) => ({
          id: String(id),
          productId: String(productId),
          name,
          quantity: String(quantity),
          amount,
          gst,
          status,
        })),
      ).toEqual(normalize(old.lines) as unknown as unknown[]);
      expect(fresh.lines).toHaveLength(3);
      expect(fresh.lines[2]?.name).toBeNull();
    });
    it('returns the legacy ShowOrderDetailsView context and enforces store assignment unless cr=1', async () => {
      await native.fixture.insert('users', {
        id: '7',
        firstname: 'Synthetic',
        lastname: 'Customer',
        email: 'synthetic7@example.invalid',
        telephone: '5550007',
        tss_money: 1.005,
        tss_points: 25.5,
      });
      await native.fixture.insert('user_eav', {
        entity: 'synthetic7@example.invalid',
        attribute: 'EXCLUSIVE_EXPIRY',
        value: '2099-01-02 00:00:00',
        is_active: 1,
      });
      await native.fixture.insert('vinculum_auto_delivered_logs', {
        id: '1',
        order_id: '9007199254740993',
        product_id: '101',
        platform: 'PACK',
        retries: 0,
        status: 'SUCCESS',
        created_at: '2026-11-17 10:05:00',
        updated_at: '2026-11-17 10:06:00',
      });
      await native.fixture.insert('order_status', { id: '1', order_status: 'Order Placed' });
      const detail = await service.detail(actor, '1', '9007199254740993');
      expect(detail.legacy).toMatchObject({
        crossAccess: false,
        customer: { id: '7', tssMoney: '1.01', tssPoints: '25.50' },
        exclusive: { member: true, expiry: '02/01/2099', message: '' },
        totalItems: 5,
        isUploaded: false,
        transactionId: 'SYNTHETIC-9007199254740993',
        vincStatus: {
          CREATE: { status: 'SUCCESS', date: '' },
          PACK: { status: 'SUCCESS', date: '2026-11-17 10:06:00' },
          SHIP: { status: '-', date: '' },
        },
        cashback: null,
      });
      await native.fixture.insert('stores', {
        id: '2',
        store_name: 'Other store',
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.connection.query(
        "UPDATE order_stores SET store_id='2',counter_id='0' WHERE order_id='7'",
      );
      await expect(service.detail(actor, '1', '7')).rejects.toMatchObject({
        status: 403,
        code: 'ORDER_STORE_FORBIDDEN',
      });
      expect((await service.detail(actor, '1', '7', { crossAccess: true })).legacy).toMatchObject({
        crossAccess: true,
        storeName: 'Other store',
      });
      await expect(service.detail(actor, '1', '123')).rejects.toMatchObject({ status: 404 });
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
    it('reads older store orders from MySQL for any date, as legacy does', async () => {
      const result = await service.list(actor, '1', undefined, 30, {
        from: '2026-11-16',
        to: '2026-11-16',
      });
      expect(result.reader).toBe('primary');
      expect(result.data.map((row) => row.id)).toEqual(['7']);
      expect((await service.detail(actor, '1', '7')).reference).toBe('SYNTHETIC-7');
      await native.connection.query('DELETE FROM user_stores WHERE django_user_id=1');
      await expect(
        service.list(actor, '1', undefined, 30, { from: '2026-11-16', to: '2026-11-16' }),
      ).rejects.toMatchObject({ status: 403 });
    });
  },
);
