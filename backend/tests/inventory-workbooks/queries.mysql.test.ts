import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inventoryWorkbookFixture } from '../../tools/inventory-workbooks/fixture.js';
import {
  readInventoryWorkbookPage,
  inventoryCandidateQuery,
  inventoryRowsQuery,
} from '../../src/modules/inventory-workbooks/queries.js';
import { inventoryWorkbookRowSchema } from '../../src/modules/inventory-workbooks/contracts.js';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { goldenStdout } from '../golden/load.js';

const connection = process.env.INVENTORY_WORKBOOK_MYSQL_TEST_URL;
describe.skipIf(!connection)(
  'workbook bound SQL against pinned source on isolated physical MySQL schema',
  () => {
    let fixture: Awaited<ReturnType<typeof inventoryWorkbookFixture>>;
    beforeAll(async () => {
      fixture = await inventoryWorkbookFixture(connection!);
    });
    beforeEach(async () => fixture.reset());
    afterAll(async () => fixture?.close());
    const read = (store = '1', after = '0', limit = 100) =>
      fixture.db
        .get('data')
        .transaction(
          (tx) => readInventoryWorkbookPage(tx, store, after, limit, new AbortController().signal),
          { accessMode: 'read only', isolationLevel: 'repeatable read' },
        );
    async function source(store: string, ids: readonly string[]) {
      const raw: unknown = JSON.parse(
          goldenStdout('inventory-workbooks', 'queries-mysql', '{"action":"queries"}'),
        ),
        query = z.object({ rows: z.string() }).parse(raw).rows;
      await fixture.admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
      const [rows] = await fixture.admin.query<mysql.RowDataPacket[]>(
        query +
          ' AND s.id = ? AND p.id IN (' +
          ids.map(() => '?').join(',') +
          ') GROUP BY p.id ORDER BY p.id',
        [store, ...ids],
      );
      await fixture.admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY'");
      return z.array(inventoryWorkbookRowSchema).parse(rows);
    }
    it('preserves cross-store parents, unfiltered Color variants, priority categories, nulls, zero/negative stock and source product flags', async () => {
      await fixture.product('100', { prod_type: 0 });
      await fixture.stock('100', '2', 99);
      for (const [id, type, stock] of [
        ['101', 1, 0],
        ['102', 4, -2],
        ['103', 5, 3],
      ] as const) {
        await fixture.product(id, {
          parent_prod_id: '100',
          prod_type: type,
          is_del: 1,
          is_avail: 0,
        });
        await fixture.stock(id, '1', stock);
      }
      await fixture.fixture.insert('attributes', { id: '1', attr: 'Color' });
      await fixture.fixture.insert('has_options', {
        prod_id: '101',
        attr_id: '1',
        attr_val: 'Café',
      });
      await fixture.fixture.insert('has_options', {
        prod_id: '101',
        attr_id: '1',
        attr_val: 'Café',
      });
      await fixture.fixture.insert('products_gs1', {
        product_id: '101',
        gtin: '9223372036854775807',
      });
      for (const [id, name] of [
        ['148', 'Excluded'],
        ['162', 'Excluded too'],
        ['153', 'Special'],
        ['200', 'Other'],
      ] as const)
        await fixture.fixture.insert('categories', { id, category: name });
      for (const [id, cat] of [
        ['10', '148'],
        ['11', '162'],
        ['12', '200'],
        ['13', '153'],
      ] as const)
        await fixture.fixture.insert('has_categories', { id, prod_id: '100', cat_id: cat });
      const page = await read();
      expect(page.candidateIds).toEqual(['101', '102', '103']);
      expect(page.rows).toEqual(await source('1', page.candidateIds));
      expect(page.rows[0]).toMatchObject({
        variant: 'Café',
        category: 'Special',
        inventory: 0,
        parent_id: '100',
        gtin: '9223372036854775807',
      });
      expect(page.rows[1]).toMatchObject({ variant: null, gtin: null, inventory: -2 });
    });
    it('keyset-pages full-width IDs and keeps candidate-only rows separate when source inner joins remove them', async () => {
      await fixture.product('9007199254740993');
      await fixture.stock('9007199254740993');
      await fixture.product('9007199254740994', { added_by: '99999' });
      await fixture.stock('9007199254740994');
      const first = await read('1', '0', 1);
      expect(first.candidateIds).toEqual(['9007199254740993']);
      expect(first.rows[0]?.child_id).toBe('9007199254740993');
      const second = await read('1', first.candidateIds[0]!, 1);
      expect(second.candidateIds).toEqual(['9007199254740994']);
      expect(second.rows).toEqual([]);
      expect(await read('1', second.candidateIds[0]!, 1)).toEqual({ candidateIds: [], rows: [] });
    });
    it.each(['variant', 'GTIN', 'category'] as const)(
      'refuses byte-distinct %s ambiguity rather than making GROUP BY deterministic by changing source semantics',
      async (field) => {
        await fixture.product('101');
        await fixture.stock('101');
        if (field === 'variant') {
          await fixture.fixture.insert('has_options', {
            prod_id: '101',
            attr_id: '1',
            attr_val: 'm',
          });
          await fixture.fixture.insert('has_options', {
            prod_id: '101',
            attr_id: '2',
            attr_val: 'M',
          });
        } else if (field === 'GTIN') {
          await fixture.fixture.insert('products_gs1', { product_id: '101', gtin: '111' });
          await fixture.fixture.insert('products_gs1', { product_id: '101', gtin: '222' });
        } else {
          await fixture.fixture.insert('categories', { id: '153', category: 'Priority' });
          await fixture.fixture.insert('categories', { id: '200', category: 'Other' });
          await fixture.fixture.insert('has_categories', {
            id: '1',
            prod_id: '101',
            cat_id: '200',
          });
          await fixture.fixture.insert('has_categories', {
            id: '2',
            prod_id: '101',
            cat_id: '153',
          });
        }
        await expect(read()).rejects.toMatchObject({
          code: 'INVENTORY_WORKBOOK_AMBIGUOUS',
          productId: '101',
          field,
        });
      },
    );
    it('does not invent rows for deleted associations, unsupported types, missing parent/artist or absent stores', async () => {
      for (const id of ['1', '2', '3', '4'])
        await fixture.product(id, {
          prod_type: id === '1' ? 2 : 1,
          parent_prod_id: id === '3' ? '99999' : '0',
          added_by: id === '4' ? '99999' : '1',
        });
      await fixture.stock('1');
      await fixture.stock('2', '1', 3, 1);
      await fixture.stock('3');
      await fixture.stock('4');
      const page = await read();
      expect(page.candidateIds).toEqual(['3', '4']);
      expect(page.rows).toEqual([]);
      expect(await read('99')).toEqual({ candidateIds: [], rows: [] });
    });
    it('keeps page predicates bound, capped and explainable using verified physical indexes', async () => {
      await fixture.product('101');
      await fixture.stock('101');
      const dialect = new MySqlDialect();
      for (const statement of [
        inventoryCandidateQuery('1', '0', 100),
        inventoryRowsQuery('1', ['101']),
      ]) {
        const query = dialect.sqlToQuery(statement);
        expect(query.sql).toContain('?');
        const [plan] = await fixture.admin.query<mysql.RowDataPacket[]>(
          'EXPLAIN FORMAT=JSON ' + query.sql,
          query.params,
        );
        expect(plan).toHaveLength(1);
        expect(JSON.stringify(plan)).toContain('product_store');
      }
      expect(() => inventoryRowsQuery('1', [])).toThrow();
      expect(() => inventoryCandidateQuery('1', '0', 5001)).toThrow();
    });
    it('keeps one repeatable-read inventory snapshot when a concurrent writer changes later-page stock', async () => {
      await fixture.product('101');
      await fixture.stock('101', '1', 3);
      await fixture.product('102');
      await fixture.stock('102', '1', 7);
      await fixture.db.get('data').transaction(
        async (tx) => {
          const first = await readInventoryWorkbookPage(
            tx,
            '1',
            '0',
            1,
            new AbortController().signal,
          );
          expect(first.rows[0]?.inventory).toBe(3);
          await fixture.admin.query(
            'UPDATE product_store SET stock=99 WHERE product_id=102 AND store_id=1',
          );
          const second = await readInventoryWorkbookPage(
            tx,
            '1',
            '101',
            1,
            new AbortController().signal,
          );
          expect(second.rows[0]?.inventory).toBe(7);
        },
        { accessMode: 'read only', isolationLevel: 'repeatable read' },
      );
      expect((await read('1', '101', 1)).rows[0]?.inventory).toBe(99);
    });
  },
);
