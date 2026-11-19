import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { sql } from 'drizzle-orm';
import { createDatabases, type Databases } from '../src/db/pools.js';
import { readConfig } from '../src/config.js';
import { injectWriteFailure } from './helpers/production-schema.js';
import { verifiedMysqlFixture } from '../tools/operational-reports/verified-mysql-fixture.js';
import {
  availableStockProjection,
  availableSystemStockProjection,
} from '../src/db/stock-projection/service.js';
import { sourceStockOracle, sourceHash } from '../tools/stock-projection/source-oracle.js';

const integration = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!integration)(
  'transaction-scoped current-schema stock projection on isolated MySQL',
  () => {
    const schema =
      'pos_rewrite_stock_projection_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const tables = [
      'products',
      'product_store',
      'product_stocks',
      'stores',
      'attributes',
      'has_options',
      'hold_stock_store',
      'product_inventory_logs',
      'pos_inventory_sync_log',
      'pos_product_inventory_logs',
      'products_inventory_logs',
    ] as const;
    let connection: mysql.Connection,
      db: Databases,
      fixture: ReturnType<typeof verifiedMysqlFixture>,
      created = false;
    const project = availableStockProjection('Asia/Kolkata', () =>
      Temporal.Instant.from('2026-11-16T08:00:00Z'),
    );
    const value = {
      storeId: '1',
      productId: '1',
      operatorId: '7',
      stock: 12,
      comment: 'Fixture stock correction',
    };
    const read = async (statement: string) =>
      z.array(z.record(z.string(), z.unknown())).parse((await connection.query(statement))[0]);
    const apply = (overrides: Partial<typeof value> = {}) =>
      db.get('writer').transaction((tx) => project(tx, { ...value, ...overrides }));
    beforeAll(async () => {
      expect(sourceHash).toBe('07246982120d152e54f897e10d6407e2fa4d49726638376e489c4ff9319d1d3e');
      const url = new URL(integration!);
      if (
        url.protocol !== 'mysql:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration' ||
        url.search ||
        url.hash
      )
        throw new Error('Stock projection tests require the explicit localhost fixture URL.');
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      created = true;
      await connection.changeUser({ database: schema });
      fixture = verifiedMysqlFixture(connection);
      await fixture.create(tables);
      url.pathname = '/' + schema;
      db = createDatabases(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: 'stock-projection-fixture-'.repeat(3),
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          MYSQL_WRITER_URL: url.href,
          MYSQL_PRIMARY_READER_URL: url.href,
        }),
      );
    });
    beforeEach(async () => {
      for (const table of tables) await connection.query(`DELETE FROM ${mysql.escapeId(table)}`);
      for (const [id, location, ecom, threshold] of [
        [1, 'STORE_A', 1, 3],
        [2, 'STORE_B', 1, 2],
        [3, 'DWH', 0, 0],
      ] as const)
        await fixture.insert('stores', {
          id,
          store_name: 'Store ' + id,
          phone: '9000000' + id,
          location_code: location,
          ecom_delivery: ecom,
          ecom_threshold: threshold,
        });
      await fixture.insert('products', {
        id: 1,
        parent_prod_id: 0,
        prod_type: 1,
        is_jit: 0,
        is_avail: 1,
        is_del: 0,
      });
      for (const [store, stock] of [
        [1, 5],
        [2, 8],
        [3, 7],
      ] as const)
        await fixture.insert('product_store', {
          product_id: 1,
          store_id: store,
          stock,
          is_avail: 1,
          is_del: 0,
        });
      await fixture.insert('product_stocks', {
        prod_id: 1,
        parent_prod_id: 0,
        stock: 999,
        stocked: 4,
      });
    });
    afterAll(async () => {
      await db?.close();
      if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection?.end();
    });
    it('matches the actual newer source queries/arithmetic and writes the three source stock audit projections', async () => {
      await apply();
      const expected = await sourceStockOracle(db.get('writer'))(1);
      expect(expected).toEqual({ stock: 18, storeStock: 15, grossStock: 22, effectiveBuffer: 4 });
      expect((await read('SELECT stock,stocked FROM product_stocks'))[0]).toEqual({
        stock: '18',
        stocked: 4,
      });
      expect(
        (
          await read('SELECT tss_stock,vinc_stock,location,created_at FROM product_inventory_logs')
        )[0],
      ).toEqual({
        tss_stock: 5,
        vinc_stock: 12,
        location: 'STORE_A',
        created_at: '2026-11-16 13:30:00',
      });
      expect((await read('SELECT tss_stock,pos_stock FROM pos_inventory_sync_log'))[0]).toEqual({
        tss_stock: 5,
        pos_stock: 12,
      });
      expect(
        (
          await read(
            'SELECT stock_before,stock_after,pos_user_id,user_id FROM pos_product_inventory_logs',
          )
        )[0],
      ).toEqual({ stock_before: '5', stock_after: '12', pos_user_id: '7', user_id: '0' });
      expect(
        (
          await read(
            'SELECT store_addon_stock,final_stock,hold_stock,user_id FROM products_inventory_logs',
          )
        )[0],
      ).toEqual({ store_addon_stock: 15, final_stock: 22, hold_stock: 0, user_id: '1606835' });
    });
    it('keeps system actor0 separate from ordinary input and records its real audit identity', async () => {
      await expect(apply({ operatorId: '0' })).rejects.toThrow();
      const forged = { ...value, system: true };
      await expect(db.get('writer').transaction((tx) => project(tx, forged))).rejects.toThrow();
      const system = availableSystemStockProjection('Asia/Kolkata', () =>
        Temporal.Instant.from('2026-11-16T08:00:00Z'),
      );
      await expect(db.get('writer').transaction((tx) => system(tx, value))).rejects.toThrow();
      expect((await read('SELECT stock FROM product_store WHERE store_id=1'))[0]?.stock).toBe(5);
      expect(await read('SELECT pos_user_id FROM pos_product_inventory_logs')).toEqual([]);
      await db.get('writer').transaction((tx) => system(tx, { ...value, operatorId: '0' }));
      expect(
        (
          await read(
            'SELECT pos_user_id,user_id,stock_before,stock_after FROM pos_product_inventory_logs',
          )
        )[0],
      ).toEqual({ pos_user_id: '0', user_id: '0', stock_before: '5', stock_after: '12' });
      const expected = await sourceStockOracle(db.get('writer'))(1);
      expect((await read('SELECT stock FROM product_stocks'))[0]?.stock).toBe(
        String(expected.stock),
      );
    });
    it('uses parent/size JSON with source escaping and does not consume held inventory twice', async () => {
      await fixture.insert('products', { id: 10, parent_prod_id: 0, prod_type: 3 });
      await connection.query('UPDATE products SET parent_prod_id=10 WHERE id=1');
      await connection.query('UPDATE product_stocks SET parent_prod_id=10 WHERE prod_id=1');
      await fixture.insert('attributes', { id: 1, attr: 'Size' });
      await fixture.insert('has_options', { id: 1, prod_id: 1, attr_id: 1, attr_val: 'M"\\' });
      await fixture.insert('hold_stock_store', { product_id: 1, store_id: 1, stock: 9 });
      await apply();
      const [audit] = await read(
        'SELECT product_id,stock_before,stock_after,type FROM pos_product_inventory_logs',
      );
      expect(audit).toEqual({
        product_id: '10',
        stock_before: JSON.stringify({ ['M"\\']: 5 }),
        stock_after: JSON.stringify({ ['M"\\']: 12 }),
        type: 3,
      });
      expect((await read('SELECT stock FROM hold_stock_store'))[0]?.stock).toBe(9);
      expect((await read('SELECT stock FROM product_store WHERE store_id=1'))[0]?.stock).toBe(12);
    });
    it('matches15 native source vectors across threshold boundaries and buffer exhaustion', async () => {
      let vectors = 0;
      for (const buffer of [0, 4, 30])
        for (const stock of [0, 2, 3, 4, 12]) {
          await connection.query('UPDATE product_stocks SET stock=999,stocked=? WHERE prod_id=1', [
            buffer,
          ]);
          await apply({ stock });
          const expected = await sourceStockOracle(db.get('writer'))(1);
          expect((await read('SELECT stock FROM product_stocks'))[0]?.stock).toBe(
            String(expected.stock),
          );
          expect((await read('SELECT stocked FROM product_stocks'))[0]?.stocked).toBe(buffer);
          vectors++;
        }
      expect(vectors).toBe(15);
    });
    it('does not change the pooled connection timezone or caller session variables', async () => {
      await db.get('writer').transaction(async (tx) => {
        await tx.execute(sql`SET @tss_stock=777`);
        const [before] = await tx.execute(
          sql`SELECT @@session.time_zone AS zone,@tss_stock AS stock`,
        );
        await project(tx, value);
        const [after] = await tx.execute(
          sql`SELECT @@session.time_zone AS zone,@tss_stock AS stock`,
        );
        expect(after).toEqual(before);
      });
    });
    it('rolls back before publishing ambiguous warehouse and overflowing audit totals', async () => {
      await fixture.insert('stores', {
        id: 4,
        store_name: 'Store 4',
        phone: '90000004',
        location_code: 'DWH',
        ecom_delivery: 0,
        ecom_threshold: 0,
      });
      await fixture.insert('product_store', {
        product_id: 1,
        store_id: 4,
        stock: 99,
        is_avail: 1,
        is_del: 0,
      });
      await expect(apply()).rejects.toMatchObject({ code: 'STOCK_LOCATION_AMBIGUOUS' });
      expect((await read('SELECT stock FROM product_store WHERE store_id=1'))[0]?.stock).toBe(5);
      expect(await read('SELECT id FROM product_inventory_logs')).toHaveLength(0);
      await connection.query('DELETE FROM product_store WHERE store_id=4');
      await expect(apply({ stock: 2_147_483_647 })).rejects.toMatchObject({
        code: 'STOCK_PROJECTION_OVERFLOW',
      });
      expect((await read('SELECT stock FROM product_store WHERE store_id=1'))[0]?.stock).toBe(5);
    });
    it('rejects conflicting source size labels without corrupting the audit', async () => {
      await connection.query('UPDATE products SET parent_prod_id=10 WHERE id=1');
      await connection.query('UPDATE product_stocks SET parent_prod_id=10 WHERE prod_id=1');
      await fixture.insert('attributes', { id: 1, attr: 'size' });
      await fixture.insert('has_options', { prod_id: 1, attr_id: 1, attr_val: 'M' });
      await fixture.insert('has_options', { prod_id: 1, attr_id: 1, attr_val: 'L' });
      await expect(apply()).rejects.toMatchObject({ code: 'STOCK_SIZE_AMBIGUOUS' });
      expect(await read('SELECT id FROM product_inventory_logs')).toHaveLength(0);
    });
    it('retains the source unchanged-stock audit without creating change logs', async () => {
      await connection.query('UPDATE product_stocks SET stock=11 WHERE prod_id=1');
      await apply({ stock: 5 });
      expect(await read('SELECT id FROM product_inventory_logs')).toHaveLength(1);
      expect(await read('SELECT id FROM pos_inventory_sync_log')).toHaveLength(0);
      expect(await read('SELECT id FROM pos_product_inventory_logs')).toHaveLength(0);
      expect(await read('SELECT id FROM products_inventory_logs')).toHaveLength(0);
    });
    it('rolls the caller transaction back after a late aggregate audit failure', async () => {
      const removeFault = await injectWriteFailure(connection, {
        table: 'products_inventory_logs',
        event: 'INSERT',
        message: 'Synthetic fixture failure',
      });
      try {
        await expect(apply()).rejects.toThrow();
        expect((await read('SELECT stock FROM product_store WHERE store_id=1'))[0]?.stock).toBe(5);
        expect((await read('SELECT stock FROM product_stocks'))[0]?.stock).toBe('999');
        for (const table of tables.slice(-4))
          expect(await read('SELECT id FROM ' + table)).toHaveLength(0);
      } finally {
        await removeFault();
      }
    });
    it('serializes20 concurrent changes and keeps the final aggregate identical to source queries', async () => {
      await Promise.all(Array.from({ length: 20 }, (_, index) => apply({ stock: 100 + index })));
      const expected = await sourceStockOracle(db.get('writer'))(1);
      expect(Number((await read('SELECT stock FROM product_stocks'))[0]?.stock)).toBe(
        expected.stock,
      );
      expect(await read('SELECT id FROM product_inventory_logs')).toHaveLength(20);
      expect(await read('SELECT id FROM pos_inventory_sync_log')).toHaveLength(20);
    });
    it('rejects missing projections and ambiguous size metadata before publishing stock', async () => {
      await connection.query('DELETE FROM product_stocks');
      await expect(apply()).rejects.toMatchObject({ code: 'STOCK_AGGREGATE_MISSING' });
      expect((await read('SELECT stock FROM product_store WHERE store_id=1'))[0]?.stock).toBe(5);
      expect(await read('SELECT id FROM product_inventory_logs')).toHaveLength(0);
    });
    it('preserves exact product and operator IDs beyond JavaScript safe integers', async () => {
      const id = '9007199254740993';
      await fixture.insert('products', { id, parent_prod_id: 0, prod_type: 1 });
      await fixture.insert('product_store', {
        product_id: id,
        store_id: 1,
        stock: 1,
        is_avail: 1,
        is_del: 0,
      });
      await fixture.insert('product_stocks', {
        prod_id: id,
        parent_prod_id: 0,
        stock: 0,
        stocked: 0,
      });
      await apply({ productId: id, operatorId: id, stock: 4 });
      const rows = await read('SELECT product_id,pos_user_id FROM pos_product_inventory_logs');
      expect(rows[0]).toEqual({ product_id: id, pos_user_id: id });
    });
  },
);
