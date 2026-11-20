import { randomUUID } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  GiftVoucher,
  Order,
  OrderAddon,
  OrderStore,
  PosPaytmTransaction,
  PosTerminalTransaction,
  Store,
} from '../../src/db/legacy-schema.js';
import { likeLiteral, orderFinalizer } from '../../src/modules/checkout/finalizer.js';
import { legacyFixtureRecord } from '../../tools/administration/mysql-fixture.js';
import { createProductionTables } from '../helpers/production-schema.js';

/**
 * `Helpers.generate_invoice_number` (helpers/helpers.py:2208-2245 at the pinned legacy source):
 * the prefix filter is Django `order_invoice__startswith=f"{store_code}…"`. Django escapes
 * `\ % _` in a `startswith` value, and an f-string formats a NULL `location_code` as 'None'.
 * Run with CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1:<port>/ (loopback only).
 */
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const tables: MySqlTable[] = [
  GiftVoucher,
  Order,
  OrderAddon,
  OrderStore,
  PosPaytmTransaction,
  PosTerminalTransaction,
  Store,
];
// orders.updated_at drives the financial year (2026-11-16 -> FY 2627).
const fy = '2627';

describe('likeLiteral', () => {
  it('escapes the LIKE metacharacters and the escape character only', () => {
    expect(likeLiteral('F_1')).toBe('F\\_1');
    expect(likeLiteral('F%1')).toBe('F\\%1');
    expect(likeLiteral('F\\1')).toBe('F\\\\1');
    expect(likeLiteral('FST1/None')).toBe('FST1/None');
  });
});

describe.skipIf(!template)('order invoice number on isolated MySQL', () => {
  let connection: Connection, db: Databases, schema: string;
  const url = () => {
    const value = new URL(template!);
    value.pathname = '/' + schema;
    return value.href;
  };
  async function seed(table: MySqlTable, values: Record<string, string | number | null>) {
    const record = Object.entries(legacyFixtureRecord(table, values));
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(getTableConfig(table).name)} (${record.map(([name]) => mysql.escapeId(name)).join(',')}) VALUES (${record.map(() => '?').join(',')})`,
      record.map(([, value]) => value),
    );
  }
  async function order(id: number, storeId: number, invoice: string | null) {
    await seed(Order, { id, updated_at: '2026-11-16 10:00:00' });
    await seed(OrderStore, { order_id: id, store_id: storeId, order_invoice: invoice });
  }
  async function finalize(orderId: number) {
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'invoice-number-fixture-secret-'.repeat(2),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_PRIMARY_READER_URL: url(),
      MYSQL_WRITER_URL: url(),
      MYSQL_DATA_READER_URL: url(),
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    const result = await orderFinalizer(db, config)(
      {
        storeId: '1',
        counterId: '1',
        customerId: null,
        operatorCustomerId: null,
        lineSalespersons: {},
        salespersonId: null,
      },
      String(orderId),
      { confirmed: false },
    );
    return result.invoice;
  }
  async function storeCode(code: string | null) {
    await seed(Store, { id: 1, store_name: 'Store 1', location_code: code, is_active: 1 });
  }

  beforeAll(async () => {
    const base = new URL(template!);
    if (!['localhost', '127.0.0.1'].includes(base.hostname))
      throw new Error('Invoice number tests require a loopback MySQL.');
    schema = `pos_e_invoice_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    connection = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    await createProductionTables(connection, tables);
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'invoice-number-fixture-secret-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_PRIMARY_READER_URL: url(),
        MYSQL_WRITER_URL: url(),
        MYSQL_DATA_READER_URL: url(),
      }),
    );
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
      await connection.end();
    }
  });
  beforeEach(async () => {
    for (const table of tables)
      await connection.query('DELETE FROM ' + mysql.escapeId(getTableConfig(table).name));
  });

  it("matches '_' in the store code literally", async () => {
    await storeCode('F_1');
    // An unescaped 'F_1…' pattern would match this other code's higher sequence.
    await order(10, 1, `FX1${fy}INV00009`);
    await order(11, 1, null);
    expect(await finalize(11)).toBe(`F_1${fy}INV00001`);
    await order(12, 1, null);
    expect(await finalize(12)).toBe(`F_1${fy}INV00002`);
  });

  it("matches '%' in the store code literally, in both legacy formats", async () => {
    await storeCode('F%');
    await order(10, 1, `FAB${fy}INV00007`);
    await order(11, 1, `FAB/${fy}/INV/00008`);
    await order(12, 1, `F%/${fy}/INV/00003`);
    await order(13, 1, null);
    expect(await finalize(13)).toBe(`F%${fy}INV00004`);
  });

  it('matches a backslash in the store code literally', async () => {
    await storeCode('F\\1');
    // Unescaped, `\1` is an escaped '1' and 'F\1…' would match 'F1…'.
    await order(10, 1, `F1${fy}INV00005`);
    await order(11, 1, null);
    expect(await finalize(11)).toBe(`F\\1${fy}INV00001`);
  });

  it("formats a NULL location code as 'None', as the legacy f-string", async () => {
    await storeCode(null);
    await order(10, 1, `None/${fy}/INV/00003`);
    await order(11, 1, null);
    expect(await finalize(11)).toBe(`None${fy}INV00004`);
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT order_invoice FROM order_stores WHERE order_id=11',
    );
    expect(rows[0]?.order_invoice).toBe(`None${fy}INV00004`);
  });
});
