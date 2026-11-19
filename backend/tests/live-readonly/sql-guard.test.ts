import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type mysql from 'mysql2/promise';
import { Order, Product, ProductStore } from '../../src/db/legacy-schema.js';
import { legacyReportSql } from '../../src/modules/legacy-report-sql.js';
import { bindReportSql } from '../../src/modules/reports.js';
import { combinedOrderQueries } from '../../src/modules/operational-reports/order-report-query.js';
import { flashSalesMysqlQuery } from '../../src/modules/operational-reports/flash-sales-query.js';
import { feedQueries } from '../../src/modules/finance/feed-query.js';
import { scheduledSourceQuery } from '../../src/modules/operational-reports/scheduled-data.js';
import { guardStatement, ReadOnlyGuardError } from '../../tools/live-readonly/sql-guard.js';
import {
  emptyStats,
  errorCode,
  guardCoreConnection,
  guardedDrizzle,
} from '../../tools/live-readonly/connection.js';
import { assertAggregateOnly, newSummary } from '../../tools/live-readonly/summary.js';

const dialect = new MySqlDialect();
const render = (value: SQL) => dialect.sqlToQuery(value).sql;

function refusedWith(text: string, code: string, options = {}) {
  let caught: unknown;
  try {
    guardStatement(text, options);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReadOnlyGuardError);
  expect((caught as ReadOnlyGuardError).code).toBe(code);
  // The refusal never echoes the statement (which could carry values), only a keyword.
  if (text.trim().length > 12)
    expect((caught as Error).message).not.toContain(text.trim().slice(0, 40));
}

describe('read-only statement guard', () => {
  it.each([
    ['INSERT INTO orders (id) VALUES (1)', 'RO_GUARD_STATEMENT'],
    ['insert ignore into orders set id = 1', 'RO_GUARD_STATEMENT'],
    ['REPLACE INTO stores (id) VALUES (1)', 'RO_GUARD_STATEMENT'],
    ['UPDATE orders SET pay_amt = 0 WHERE id = 1', 'RO_GUARD_STATEMENT'],
    ['update `pos_user` set `last_login` = ? where `id` = ?', 'RO_GUARD_STATEMENT'],
    ['DELETE FROM orders WHERE id = 1', 'RO_GUARD_STATEMENT'],
    ['CREATE TABLE x (id int)', 'RO_GUARD_STATEMENT'],
    ['DROP TABLE orders', 'RO_GUARD_STATEMENT'],
    ['ALTER TABLE orders ADD COLUMN x int', 'RO_GUARD_STATEMENT'],
    ['TRUNCATE TABLE orders', 'RO_GUARD_STATEMENT'],
    ['RENAME TABLE orders TO o2', 'RO_GUARD_STATEMENT'],
    ['CREATE INDEX i ON orders (id)', 'RO_GUARD_STATEMENT'],
    ['CALL pos_stock_syncer(1,2,3,0,1,?)', 'RO_GUARD_STATEMENT'],
    ['LOCK TABLES orders READ', 'RO_GUARD_STATEMENT'],
    ['DO SLEEP(5)', 'RO_GUARD_STATEMENT'],
    ['LOAD DATA INFILE "x" INTO TABLE orders', 'RO_GUARD_STATEMENT'],
    ['HANDLER orders OPEN', 'RO_GUARD_STATEMENT'],
    ['SAVEPOINT sp1', 'RO_GUARD_STATEMENT'],
    ['GRANT ALL ON *.* TO x', 'RO_GUARD_STATEMENT'],
    ['WITH t AS (SELECT 1) DELETE FROM orders', 'RO_GUARD_WRITE_KEYWORD'],
    ['WITH t AS (SELECT id FROM orders) UPDATE orders SET id = 1', 'RO_GUARD_WRITE_KEYWORD'],
    ['SELECT * FROM orders INTO OUTFILE "/tmp/x"', 'RO_GUARD_INTO'],
    ['SELECT id INTO @x FROM orders LIMIT 1', 'RO_GUARD_INTO'],
    ['SELECT LOAD_FILE("/etc/passwd")', 'RO_GUARD_WRITE_KEYWORD'],
    ['SELECT GET_LOCK("x", 1)', 'RO_GUARD_WRITE_KEYWORD'],
    ['SELECT SLEEP(100)', 'RO_GUARD_WRITE_KEYWORD'],
    ['EXPLAIN ANALYZE SELECT * FROM orders', 'RO_GUARD_STATEMENT'],
    ['EXPLAIN DELETE FROM orders', 'RO_GUARD_STATEMENT'],
    ['SHOW CREATE PROCEDURE pos_stock_syncer', 'RO_GUARD_STATEMENT'],
    ['SHOW GRANTS', 'RO_GUARD_STATEMENT'],
    ['', 'RO_GUARD_EMPTY'],
    ['   -- only a comment\n', 'RO_GUARD_EMPTY'],
  ])('refuses %s', (text, code) => refusedWith(text, code));

  it.each([
    'SELECT id FROM orders WHERE id = 1 FOR UPDATE',
    'select `id` from `stores` where `id` = ? limit ? for update',
    'SELECT id FROM orders FOR UPDATE NOWAIT',
    'SELECT id FROM orders FOR UPDATE SKIP LOCKED',
  ])('refuses SELECT … FOR UPDATE: %s', (text) => refusedWith(text, 'RO_GUARD_LOCKING_READ'));

  it('in harness downgrade mode, sends a trailing FOR UPDATE only as a plain read and refuses any other', () => {
    expect(
      guardStatement('select `id` from `stores` where `id` = ? limit ? for update', {
        lockingReads: 'downgrade',
      }),
    ).toEqual({
      kind: 'read',
      sql: 'select `id` from `stores` where `id` = ? limit ?',
      downgraded: true,
      lock: 'update',
      explainable: true,
    });
    expect(
      guardStatement('SELECT id FROM orders FOR UPDATE SKIP LOCKED', { lockingReads: 'downgrade' })
        .sql,
    ).toBe('SELECT id FROM orders');
    for (const text of [
      'SELECT id FROM (SELECT id FROM orders FOR UPDATE) o',
      'SELECT id FROM orders FOR UPDATE UNION SELECT id FROM orders',
      'SELECT id FROM orders FOR UPDATE FOR SHARE',
    ])
      refusedWith(text, 'RO_GUARD_LOCKING_READ', { lockingReads: 'downgrade' });
    refusedWith('UPDATE orders SET id = 1 FOR UPDATE', 'RO_GUARD_STATEMENT', {
      lockingReads: 'downgrade',
    });
  });

  it('refuses shared locking reads by default and downgrades only a trailing clause', () => {
    refusedWith(
      'select `id` from `stores` where `id` = ? limit ? for share',
      'RO_GUARD_LOCKING_READ',
    );
    refusedWith('SELECT id FROM stores LOCK IN SHARE MODE', 'RO_GUARD_LOCKING_READ');
    const shared = guardStatement('select `id` from `stores` where `id` = ? limit ? for share', {
      lockingReads: 'downgrade',
    });
    expect(shared).toEqual({
      kind: 'read',
      sql: 'select `id` from `stores` where `id` = ? limit ?',
      downgraded: true,
      lock: 'share',
      explainable: true,
    });
    expect(
      guardStatement('SELECT id FROM stores LOCK IN SHARE MODE', { lockingReads: 'downgrade' }).sql,
    ).toBe('SELECT id FROM stores');
    refusedWith('SELECT id FROM (SELECT id FROM stores FOR SHARE) s', 'RO_GUARD_LOCKING_READ', {
      lockingReads: 'downgrade',
    });
  });

  it.each([
    'SET SESSION sql_mode = ""',
    "SET sql_mode=''",
    'SET GLOBAL read_only = 0',
    'SET @x = 1',
    'SET NAMES utf8mb4',
    'SET SESSION TRANSACTION READ WRITE',
    'SET TRANSACTION READ WRITE',
    'SET SESSION MAX_EXECUTION_TIME=0',
    'SET SESSION MAX_EXECUTION_TIME=10001',
    'SET SESSION MAX_EXECUTION_TIME=60000',
    'SET autocommit = 0',
    'SET PASSWORD = "x"',
  ])('refuses SET other than the two session statements: %s', (text) =>
    refusedWith(text, 'RO_GUARD_SET'),
  );

  it.each([
    'SELECT 1; DELETE FROM orders',
    'SELECT 1;SELECT 2',
    'SELECT 1;',
    "SELECT 'a'; UPDATE orders SET id = 1",
  ])('refuses multi-statement text: %s', (text) => refusedWith(text, 'RO_GUARD_MULTI_STATEMENT'));

  it('refuses executable comments and unterminated text', () => {
    refusedWith('SELECT 1 /*!50000 , (DELETE FROM orders) */', 'RO_GUARD_EXECUTABLE_COMMENT');
    refusedWith('/*!40101 SET sql_mode = "" */', 'RO_GUARD_EXECUTABLE_COMMENT');
    refusedWith("SELECT 'unterminated", 'RO_GUARD_UNTERMINATED');
    refusedWith('SELECT 1 /* open', 'RO_GUARD_UNTERMINATED');
  });

  it('allows exactly the two session statements and the transaction brackets', () => {
    expect(guardStatement('SET SESSION TRANSACTION READ ONLY').kind).toBe('session');
    expect(guardStatement('SET SESSION MAX_EXECUTION_TIME=10000').kind).toBe('session');
    expect(guardStatement('set session max_execution_time = 2500').kind).toBe('session');
    for (const text of [
      'begin',
      'commit',
      'rollback',
      'start transaction',
      'start transaction read only',
      'start transaction with consistent snapshot',
      'set transaction isolation level repeatable read',
    ])
      expect(guardStatement(text).kind).toBe('transaction');
    refusedWith('start transaction read write', 'RO_GUARD_STATEMENT');
  });

  it('allows reads, keeping strings, identifiers and comments opaque', () => {
    for (const text of [
      'SELECT 1',
      "SELECT 'DELETE; DROP TABLE orders' AS x",
      'SELECT `delete`, `update` FROM `orders` WHERE `id` = ?',
      "SELECT REPLACE(name, 'a', 'b'), INSERT(name, 1, 1, 'x') FROM stores LIMIT 5",
      'SELECT id -- DELETE FROM orders; \nFROM orders LIMIT 5',
      'SELECT id # UPDATE; \nFROM orders LIMIT 5',
      "SELECT CAST(id AS CHAR CHARACTER SET utf8mb4) FROM orders WHERE note = 'it''s' LIMIT 1",
      '(SELECT id FROM orders LIMIT 1) UNION ALL (SELECT id FROM orders LIMIT 1)',
      'WITH t AS (SELECT id FROM orders LIMIT 5) SELECT * FROM t',
      'SELECT @rownum := @rownum + 1 AS n FROM orders CROSS JOIN (SELECT @rownum := 0) r LIMIT 5',
      'select /*+ JOIN_ORDER(products, product_store) */ `products`.`id` from `products` limit ?',
      'SHOW CREATE TABLE `orders`',
      'SHOW COLUMNS FROM orders',
      'DESCRIBE orders',
      'EXPLAIN SELECT id FROM orders WHERE id = 1',
      'EXPLAIN FORMAT=JSON SELECT id FROM orders WHERE id = 1',
    ])
      expect(guardStatement(text).kind).toBe('read');
    expect(guardStatement('EXPLAIN SELECT 1').explainable).toBe(false);
    expect(guardStatement('SHOW CREATE TABLE `orders`').explainable).toBe(false);
  });

  it('accepts every legacy report SQL exception (E3) and the rewrite builder SQL as rendered', () => {
    const texts = [
      legacyReportSql.excludedProducts,
      render(
        bindReportSql(
          legacyReportSql.storeOrders,
          ['1'],
          [5n],
          '2026-11-18 00:00:00',
          '2026-11-18 23:59:59',
        ),
      ),
      render(
        bindReportSql(
          legacyReportSql.onlineOrders,
          ['1'],
          [5n],
          '2026-11-18 00:00:00',
          '2026-11-18 23:59:59',
        ),
      ),
      ...(['store', 'online'] as const).flatMap((source) =>
        (['order_date', 'return_date'] as const).flatMap((dateType) => {
          const query = combinedOrderQueries(
            source,
            dateType,
            '2026-11-18 00:00:00',
            '2026-11-18 23:59:59',
            ['1'],
          );
          return [
            render(
              sql`(${query.sales}) UNION ALL (${query.returns}) ORDER BY transaction_date DESC,id DESC LIMIT ${25} OFFSET ${0}`,
            ),
            render(sql`SELECT (${query.salesCount})+(${query.returnsCount}) AS count`),
          ];
        }),
      ),
      ...(['interactive', 'export'] as const).map((kind) =>
        render(
          sql`${flashSalesMysqlQuery(kind, '2026-11-18 00:00:00', '2026-11-18 23:59:59', ['1'])} LIMIT 70001`,
        ),
      ),
      render(feedQueries('2026-11-18', '2026-11-19', 'LOC1').sales),
      render(feedQueries('2026-11-18', '2026-11-19').sales),
      ...(
        [
          'timing',
          'summary',
          'availability',
          'platform',
          'delays',
          'cancellations',
          'tickets',
        ] as const
      ).map((kind) =>
        render(
          scheduledSourceQuery(
            kind,
            {
              from: '2026-11-18 00:00:00',
              end: '2026-11-18 01:00:00',
              windowStart: '2026-11-17 01:00:00',
            },
            true,
          ),
        ),
      ),
    ];
    for (const text of texts) expect(guardStatement(text).kind).toBe('read');
  });
});

/** A fake mysql2 promise pool that records every statement that would reach the network. */
function recordingPool() {
  const sent: string[] = [];
  const connection = {
    async query(argument: string | { sql: string }) {
      sent.push(typeof argument === 'string' ? argument : argument.sql);
      return [[], []];
    },
    async execute(argument: string | { sql: string }) {
      sent.push(typeof argument === 'string' ? argument : argument.sql);
      return [[], []];
    },
    release() {},
  };
  const pool = { ...connection, getConnection: async () => connection };
  return { sent, pool: pool as unknown as mysql.Pool };
}

describe('guarded Drizzle session and mysql2 pool', () => {
  it('throws before sending any write built with the ORM, inside or outside a transaction', async () => {
    const { sent, pool } = recordingPool(),
      stats = emptyStats(),
      { db } = guardedDrizzle(pool, stats);
    await expect(db.insert(Order).values({ id: 1n } as never)).rejects.toBeInstanceOf(
      ReadOnlyGuardError,
    );
    await expect(
      db
        .update(Product)
        .set({ product: 'x' })
        .where(sql`1=1`),
    ).rejects.toBeInstanceOf(ReadOnlyGuardError);
    await expect(db.delete(ProductStore)).rejects.toBeInstanceOf(ReadOnlyGuardError);
    await expect(db.execute(sql`SET SESSION sql_mode = ''`)).rejects.toBeInstanceOf(
      ReadOnlyGuardError,
    );
    await expect(db.execute(sql.raw('SELECT 1; DELETE FROM orders'))).rejects.toBeInstanceOf(
      ReadOnlyGuardError,
    );
    expect(sent).toEqual([]);
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(Product)
          .set({ product: 'x' })
          .where(sql`1=1`);
      }),
    ).rejects.toBeInstanceOf(ReadOnlyGuardError);
    // Only the transaction brackets reached the driver; the write never did.
    expect(sent).toEqual(['begin', 'rollback']);
    expect(stats.refused).toBe(6);
    expect(new Set(stats.refusedCodes)).toEqual(
      new Set(['RO_GUARD_STATEMENT', 'RO_GUARD_SET', 'RO_GUARD_MULTI_STATEMENT']),
    );
  });

  it('sends reads, downgrading a trailing lock clause and EXPLAINing SELECTs first', async () => {
    const { sent, pool } = recordingPool(),
      explained: string[] = [],
      stats = emptyStats(),
      { db } = guardedDrizzle(pool, stats, async (_target, text) => {
        explained.push(text);
      });
    await db
      .select({ id: Order.id })
      .from(Order)
      .where(sql`${Order.id} = ${1n}`)
      .limit(1)
      .for('share');
    await db
      .select({ id: Order.id })
      .from(Order)
      .where(sql`${Order.id} = ${1n}`)
      .limit(1)
      .for('update');
    expect(sent).toEqual([
      'select `id` from `orders` where `orders`.`id` = ? limit ?',
      'select `id` from `orders` where `orders`.`id` = ? limit ?',
    ]);
    expect(explained).toEqual(sent);
    expect(stats.downgradedLocks).toBe(2);
    expect(stats.downgradedUpdateLocks).toBe(1);
  });

  it('in strict mode refuses every locking read before sending it', async () => {
    const { sent, pool } = recordingPool(),
      { db } = guardedDrizzle(pool, emptyStats(), undefined, 'refuse');
    await expect(
      db.select({ id: Order.id }).from(Order).limit(1).for('update'),
    ).rejects.toBeInstanceOf(ReadOnlyGuardError);
    await expect(
      db.select({ id: Order.id }).from(Order).limit(1).for('share'),
    ).rejects.toBeInstanceOf(ReadOnlyGuardError);
    expect(sent).toEqual([]);
  });

  it('refuses a write on the raw pool and on a pool connection', async () => {
    const { sent, pool } = recordingPool(),
      guarded = guardedDrizzle(pool, emptyStats()).pool;
    await expect(guarded.query('DELETE FROM orders')).rejects.toBeInstanceOf(ReadOnlyGuardError);
    const connection = await guarded.getConnection();
    await expect(connection.query('UPDATE orders SET id = 1')).rejects.toBeInstanceOf(
      ReadOnlyGuardError,
    );
    await expect(connection.execute('INSERT INTO orders VALUES (1)')).rejects.toBeInstanceOf(
      ReadOnlyGuardError,
    );
    expect(sent).toEqual([]);
  });

  it('wraps a core mysql2 connection so nothing but reads reaches its query/execute/prepare', () => {
    const sent: string[] = [];
    const core = {
      query(argument: unknown) {
        sent.push(String(argument));
      },
      execute(argument: unknown) {
        sent.push(String(argument));
      },
      prepare(argument: unknown) {
        sent.push(String(argument));
      },
    };
    const stats = emptyStats();
    guardCoreConnection(core, stats);
    expect(() => core.query('DELETE FROM orders')).toThrow(ReadOnlyGuardError);
    expect(() => core.query({ sql: 'SELECT id FROM orders FOR SHARE' })).toThrow(
      ReadOnlyGuardError,
    );
    expect(() => core.query('SELECT id FROM orders WHERE id = 1 FOR UPDATE')).toThrow(
      ReadOnlyGuardError,
    );
    expect(() => core.execute('SET @x = 1')).toThrow(ReadOnlyGuardError);
    expect(() => core.prepare('SELECT 1')).toThrow(ReadOnlyGuardError);
    core.query('SET SESSION TRANSACTION READ ONLY');
    core.query({ sql: 'SELECT 1' });
    expect(sent).toEqual(['SET SESSION TRANSACTION READ ONLY', '[object Object]']);
    expect(stats.refused).toBe(5);
    let broken = false;
    const second = { query: (argument: unknown) => sent.push(String(argument)) };
    guardCoreConnection(second, emptyStats(), () => broken);
    broken = true;
    expect(() => second.query('SELECT 1')).toThrow(ReadOnlyGuardError);
  });
});

describe('aggregate-only output', () => {
  it('prints error codes, never messages', () => {
    expect(
      errorCode(
        Object.assign(new Error('Access denied for user secret@10.0.0.1'), {
          code: 'ER_ACCESS_DENIED_ERROR',
        }),
      ),
    ).toBe('ER_ACCESS_DENIED_ERROR');
    expect(errorCode(new Error('near "WHERE email = \'a@b.c\'"'))).toBe('UNKNOWN');
  });

  it('rejects free text that is not a code, name or type', () => {
    const summary = newSummary(10000, 100000);
    expect(() => assertAggregateOnly(summary)).not.toThrow();
    summary.paths.push({
      path: 'x',
      status: 'fail',
      reason: 'person@example.com',
      rows: 0,
      checks: [],
      statements: 0,
      explains: 0,
      downgradedLocks: 0,
      downgradedUpdateLocks: 0,
      refused: 0,
      planRejected: [],
      durationMs: 0,
    });
    expect(() => assertAggregateOnly(summary)).toThrow();
  });
});
