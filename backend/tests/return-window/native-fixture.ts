import { randomUUID } from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import {
  Comments,
  ExclusiveUser,
  GiftCardCollection,
  GiftVoucher,
  HasProduct,
  MUser,
  Order,
  OrderStatus,
  OrderStore,
  PosTransactionLog,
  PosUser,
  Product,
  ProductInventoryLog,
  ProductStore,
  Store,
  StoreCounter,
  StoreDayClose,
  UserStore,
} from '../../src/db/legacy-schema.js';
import {
  aggregateStock,
  aggregateStockLog,
  physicalStockLog,
  storeStockLog,
} from '../../src/db/stock-projection/schema.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const fixtureSecret = 'isolated-return-window-native-fixture-'.repeat(3);

/** Isolated per-run schema with the legacy order tables the return-window
 * native test reads. Formerly provided by the deleted CSV order-import
 * fixtures; the import-only tables and migrations are no longer created. */
export async function returnWindowNativeFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_checkout_test' ||
    url.search ||
    url.hash
  )
    throw new Error('Isolated checkout URL required.');
  const schema = 'pos_rewrite_return_window_' + randomUUID().replaceAll('-', '').slice(0, 12),
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
  try {
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection),
      base = [PosUser, Store, StoreCounter, UserStore].map(getTableName),
      extra = [
        MUser,
        Order,
        OrderStore,
        HasProduct,
        OrderStatus,
        Comments,
        PosTransactionLog,
        ProductStore,
        Product,
        GiftVoucher,
        StoreDayClose,
        ExclusiveUser,
        GiftCardCollection,
        ProductInventoryLog,
        aggregateStock,
        physicalStockLog,
        storeStockLog,
        aggregateStockLog,
      ].map(getTableName);
    await fixture.create([...base, ...extra, 'amount_to_be_refunded_log']);
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: fixtureSecret,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
      }),
      db = createDatabases(config);
    return {
      config,
      db,
      connection,
      fixture,
      async reset() {
        for (const table of ['amount_to_be_refunded_log', ...extra, ...base])
          await connection.query('DELETE FROM ' + mysql.escapeId(table));
        await fixture.insert(getTableName(PosUser), {
          id: '1',
          username: 'fixture-admin',
          [PosUser.role.name]: 1,
          [PosUser.user_type.name]: 1,
          [PosUser.is_active.name]: 1,
        });
        await fixture.insert(getTableName(Store), {
          id: '1',
          [Store.type.name]: 'STORE',
          [Store.is_active.name]: 1,
        });
        await fixture.insert(getTableName(StoreCounter), {
          id: '2',
          [StoreCounter.store.name]: '1',
          [StoreCounter.is_active.name]: 1,
        });
        await connection.query("UPDATE stores SET location_code='FIXTURE' WHERE id=1");
        await fixture.insert('users', {
          id: '77',
          email: 'private-import@example.test',
          telephone: '',
          status: 1,
          is_block: 0,
          is_disabled: 0,
        });
        await fixture.insert('products', {
          id: '9007199254740993',
          prod_type: 1,
          parent_prod_id: 0,
        });
        await fixture.insert('product_stocks', {
          prod_id: '9007199254740993',
          parent_prod_id: 0,
          stock: 100,
          stocked: 0,
        });
        await fixture.insert('product_store', {
          id: '1',
          product_id: '9007199254740993',
          store_id: '1',
          stock: 100,
          is_avail: 1,
          is_del: 0,
        });
        await fixture.insert('order_status', { id: '3', order_status: 'DELIVERED' });
      },
      async close() {
        await db.close();
        await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
        await connection.end();
      },
    };
  } catch (error) {
    await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
    await connection.end();
    throw error;
  }
}
