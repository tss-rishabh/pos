import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  customerHistoryFixtures,
  type HistoryFixture,
} from '../../tools/customer-history/fixtures.js';
import { goldenSpawnResult } from '../golden/load.js';

describe.skipIf(!process.env.MYSQL_INTEGRATION_URL)(
  'pinned customer history on isolated native MySQL',
  () => {
    let connection: mysql.Connection | undefined,
      schema = '',
      fixture: ReturnType<typeof verifiedMysqlFixture> | undefined;
    const db = () => {
        if (!connection || !fixture) throw new Error('Fixture unavailable.');
        return { connection, fixture };
      },
      tables = ['nps_feedback', 'has_products', 'order_stores', 'orders', 'products', 'users'];
    const source = goldenSpawnResult('customer-history', 'mysql-integration');
    expect(source.status, source.stderr).toBe(0);
    const queries = z
      .object({ queries: z.record(z.string(), z.string()) })
      .parse(JSON.parse(source.stdout) as unknown).queries;
    beforeAll(async () => {
      const url = new URL(process.env.MYSQL_INTEGRATION_URL!);
      if (
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration'
      )
        throw new Error('GUARDED_LOCAL_HISTORY_DATABASE_REQUIRED');
      schema = 'pos_rewrite_customer_history_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
      await connection.changeUser({ database: schema });
      fixture = verifiedMysqlFixture(connection);
      await fixture.create(tables);
      await connection.query("SET SESSION time_zone='+00:00'");
      await connection.query('SET timestamp=?', [Date.parse('2026-11-16T10:00:00Z') / 1000]);
    });
    afterAll(async () => {
      if (connection) {
        await connection.changeUser({ database: 'mysql' });
        await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
        await connection.end();
      }
    });
    const captured: { name: string; dataset: HistoryFixture; expected: Record<string, unknown> }[] =
      [];
    for (const vector of customerHistoryFixtures())
      it('matches source SQL and source row semantics: ' + vector.name, async () => {
        const { connection, fixture } = db();
        for (const table of tables) await connection.query('DELETE FROM ' + mysql.escapeId(table));
        await fixture.insert('users', { id: 7, status: 1, is_block: 0 });
        for (const row of vector.products)
          await fixture.insert('products', { ...row, prod_type: 1 });
        for (const row of vector.orders) await fixture.insert('orders', row);
        for (const row of vector.order_stores) await fixture.insert('order_stores', row);
        for (const row of vector.has_products) await fixture.insert('has_products', row);
        for (const row of vector.nps_feedback) await fixture.insert('nps_feedback', row);
        const result: Record<string, unknown> = {};
        for (const [name, statement] of Object.entries(queries)) {
          const [rows] = await connection.query<mysql.RowDataPacket[]>(statement);
          result[name] = Object.values(rows[0] || {});
        }
        const total = z
            .tuple([z.coerce.bigint(), z.coerce.bigint()])
            .parse(result.get_total_orders),
          summary = {
            exclusiveSavings: Number((result.get_lifetime_exclusive_savings as unknown[])[0]),
            totalOrders: String(total[1]),
            totalStoreOrders: String(total[0]),
            totalOnlineOrders: String(total[1] - total[0]),
            last30DaysOrders: String((result.get_last_orders as unknown[])[0]),
            cancelledOrders: '0',
            returnedOrders: '0',
            npsScore:
              (result.get_nps_score as unknown[])[0] === null
                ? null
                : Number((result.get_nps_score as unknown[])[0]),
          };
        const [counts] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT SUM(order_status=4) cancelled,SUM(order_status=6) returned FROM orders WHERE user_id=7',
        );
        summary.cancelledOrders = String(counts[0]?.cancelled || 0);
        summary.returnedOrders = String(counts[0]?.returned || 0);
        const [recent] = await connection.query<mysql.RowDataPacket[]>(
          "SELECT CAST(o.id AS CHAR) id,o.order_amt orderAmount,DATE_FORMAT(DATE(o.created_at),'%Y-%m-%d') createdDate,o.order_status status,EXISTS(SELECT 1 FROM order_stores os WHERE os.order_id=o.id) isStoreOrder FROM orders o WHERE o.user_id=7 ORDER BY DATE(o.created_at) DESC,o.id DESC LIMIT 5",
        );
        const [returned] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT CAST(o.id AS CHAR) id,o.order_amt orderAmount,EXISTS(SELECT 1 FROM order_stores os WHERE os.order_id=o.id) isStoreOrder FROM orders o WHERE o.user_id=7 AND o.order_status=6 ORDER BY o.id DESC',
        );
        const returnedRows: Record<string, unknown>[] = [];
        for (const row of returned) {
          const [items] = await connection.query<mysql.RowDataPacket[]>(
            'SELECT p.product name FROM has_products hp INNER JOIN products p ON p.id=hp.prod_id WHERE hp.order_id=? ORDER BY hp.id DESC',
            [row.id],
          );
          returnedRows.push({
            ...row,
            isStoreOrder: String(row.isStoreOrder) === '1',
            itemNames: items.slice(0, 20).map((item) => item.name as string),
            itemCount: String(items.length),
            hasMoreItems: items.length > 20,
          });
        }
        const expected = {
          summary,
          recentOrders: recent.map((row) => ({
            ...row,
            status: Number(row.status),
            isStoreOrder: String(row.isStoreOrder) === '1',
          })),
          returnedRows,
        };
        if (vector.name === 'source-multiplicity')
          expect(summary).toEqual({
            exclusiveSavings: 70,
            totalOrders: '7',
            totalStoreOrders: '3',
            totalOnlineOrders: '4',
            last30DaysOrders: '4',
            cancelledOrders: '1',
            returnedOrders: '1',
            npsScore: 19 / 6,
          });
        if (vector.name === 'approximate-half-even-up') expect(summary.exclusiveSavings).toBe(72);
        if (vector.name === 'empty-customer')
          expect(summary).toMatchObject({ exclusiveSavings: 0, totalOrders: '0', npsScore: null });
        if (vector.name === 'return-pagination-and-same-day-ties') {
          expect(returnedRows).toHaveLength(8);
          expect(
            returnedRows.every((row) => row.itemCount === '23' && row.hasMoreItems === true),
          ).toBe(true);
        }
        captured.push({ name: vector.name, dataset: vector, expected });
      });
    it('preserves the source Latin1 feedback constraint instead of changing fixture collation for unsupported characters', async () => {
      // Production runs with an empty (non-strict) sql_mode (AGENTS.md), so MySQL does not
      // reject characters outside latin1: it stores '?' and raises warning 1366
      // (ER_TRUNCATED_WRONG_VALUE_FOR_FIELD). The fixture keeps the native latin1 column.
      const { connection, fixture } = db();
      await fixture.insert('nps_feedback', {
        id: 999,
        order_id: '9007199254740993',
        feedback_answer: '１２',
      });
      const [warnings] = await connection.query<mysql.RowDataPacket[]>('SHOW WARNINGS');
      expect(warnings.map((row) => Number(row.Code))).toContain(1366);
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT feedback_answer FROM nps_feedback WHERE id=999',
      );
      expect(rows.map((row) => row.feedback_answer as string)).toEqual(['??']);
      await connection.query('DELETE FROM nps_feedback WHERE id=999');
    });
    it('publishes only generated fixture evidence for the BigQuery literal differential runner', async () => {
      expect(captured).toHaveLength(customerHistoryFixtures().length);
      await mkdir('parity/evidence/customer-history', { recursive: true });
      const file = 'parity/evidence/customer-history/native-fixtures.json',
        temporary = file + '.' + randomUUID() + '.tmp';
      await writeFile(
        temporary,
        JSON.stringify(
          {
            scope: 'generated-local-fixtures-only',
            source: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
            vectors: captured,
          },
          null,
          2,
        ) + '\n',
      );
      await rename(temporary, file);
    });
  },
);
