import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { and, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  ExpressLineItem,
  HasProduct,
  Order,
  OrderStatus,
  Store,
} from '../../src/db/legacy-schema.js';
import {
  hyperlocalDailyMysqlCount,
  hyperlocalDailyMysqlPage,
  hyperlocalDailyPartialRow,
} from '../../src/modules/operational-reports/hyperlocal-daily.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/**
 * W11 characterisation: the DATA-reader hyperlocal daily count/page queries moved from raw
 * `sql` statements to the Drizzle builder. The raw statements below are the pre-conversion
 * text (hyperlocal-daily.ts at 43613a75), kept verbatim as the frozen oracle.
 */
interface Filters {
  from: string;
  to: string;
  scope: { ids: readonly string[]; global: boolean };
}
function oldBase(filters: Filters) {
  const where = and(
    sql`${ExpressLineItem.pending_expires_at}>=${filters.from}`,
    sql`${ExpressLineItem.pending_expires_at}<=${filters.to}`,
    filters.scope.global
      ? undefined
      : sql`${ExpressLineItem.store_id} IN (${sql.join(
          filters.scope.ids.map((id) => sql`${id}`),
          sql`,`,
        )})`,
  );
  return sql`FROM ${ExpressLineItem} JOIN ${Order} ON ${Order.id}=${ExpressLineItem.order} JOIN ${HasProduct} ON ${HasProduct.id}=${ExpressLineItem.has_product} JOIN ${Store} ON ${Store.id}=${ExpressLineItem.store_id} LEFT JOIN ${OrderStatus} ON ${OrderStatus.id}=${Order.order_statuses} WHERE ${where} GROUP BY ${Order.id},${Order.user},${HasProduct.id},${Order.first_name},${Order.last_name},${Order.created_at},${Order.order_statuses},${HasProduct.status},${ExpressLineItem.status},${Store.id},${Store.location_code},${Store.store_name}`;
}
const oldCount = (filters: Filters) =>
  sql`SELECT COUNT(*) AS count FROM (SELECT ${HasProduct.id} ${oldBase(filters)}) AS report_rows`;
const oldPage = (filters: Filters, direction: 'asc' | 'desc', limit: number, offset: number) =>
  sql`SELECT ${Order.id} AS order_id,${Order.user} AS user_id,${HasProduct.id} AS line_item_id,ANY_VALUE(${HasProduct.product}) AS sku_id,CONCAT(${Order.first_name},' ',${Order.last_name}) AS customer_name,SUM(${HasProduct.qty}) AS qty,ROUND(SUM(COALESCE(${HasProduct.pre_gst_amt},0)*(1+COALESCE(${HasProduct.gst},0)/100)),2) AS amount,ANY_VALUE(${OrderStatus.display_name}) AS order_status,${HasProduct.status} AS line_item_status,${ExpressLineItem.status} AS express_line_item_status,${Order.created_at} AS order_date,${Store.id} AS store_id,${Store.location_code} AS location_code,${Store.store_name} AS store_name ${oldBase(filters)} ORDER BY order_date ${sql.raw(direction)},order_id DESC,line_item_id DESC,store_id ASC,express_line_item_status ASC LIMIT ${limit} OFFSET ${offset}`;
const counts = z.array(
  z.object({ count: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
);

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('hyperlocal daily DATA queries: builder equals former raw SQL', () => {
  const schema = `pos_rewrite_hyperlocal_orm_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Hyperlocal ORM fixture requires local MySQL.');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await admin.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(admin);
    await fixture.create(['orders', 'has_products', 'express_line_item', 'stores', 'order_status']);
    await fixture.insert('stores', { id: 1, store_name: 'Alpha', location_code: 'A-1' });
    await fixture.insert('stores', { id: 2, store_name: 'Beta', location_code: '' });
    await fixture.insert('stores', { id: 3, store_name: 'Gamma', location_code: 'G-3' });
    await fixture.insert('order_status', { id: 3, display_name: 'Delivered' });
    // Orders: tied created_at values, a BIGINT user above 2^53, a missing order_status row.
    const orders = [
      [1001, '9007199254740993', 'Ann', 'Lee', '2026-11-15 10:00:00', 3],
      [1002, '7', 'Bob', '', '2026-11-15 10:00:00', 3],
      [1003, '8', 'Cy', 'Day', '2026-11-16 09:30:00', 99],
      [1004, '9', 'Di', 'Ewe', '2026-11-14 08:00:00', 3],
      [1005, '10', 'Ed', 'Fox', '2026-11-16 09:30:00', 3],
    ] as const;
    for (const [id, user, first, last, createdAt, status] of orders)
      await fixture.insert('orders', {
        id,
        user_id: user,
        first_name: first,
        last_name: last,
        created_at: createdAt,
        order_status: status,
      });
    const lines = [
      // hp id, order, product, qty, pre_gst, gst, hp status, eli store, eli status, expiry
      [1, 1001, 22, 2, '100.00', 18, 'DELIVERED', 1, 'PACKED', '2026-11-16 00:00:00'],
      [2, 1001, 23, 1, '33.33', 5, 'PLACED', 1, null, '2026-11-16 12:00:00'],
      [3, 1002, 24, 3, '10.10', 12, 'DELIVERED', 2, 'DELIVERED', '2026-11-16 23:59:59'],
      [4, 1003, 25, 1, '0.00', 0, 'CANCELLED', 1, 'REJECTED', '2026-11-16 05:00:00'],
      [5, 1004, 26, 5, '19.99', 28, 'SHIPPED', 3, 'ACCEPTED', '2026-11-16 06:00:00'],
      [6, 1005, 27, 4, '45.50', 18, 'DELIVERED', 2, 'OUT_FOR_DELIVERY', '2026-11-16 07:00:00'],
      [7, 1005, 28, 1, '45.50', 18, 'DELIVERED', 3, 'PENDING', '2026-11-17 00:00:00'],
      [8, 1003, 29, 2, '12.34', 5, 'DELIVERED', 2, 'PACKED', '2026-11-15 23:59:59'],
    ] as const;
    for (const [id, order, product, qty, amount, gst, status, store, eli, expiry] of lines) {
      await fixture.insert('has_products', {
        id,
        order_id: order,
        prod_id: product,
        qty,
        pre_gst_amt: amount,
        gst,
        status,
      });
      await fixture.insert('express_line_item', {
        order_id: order,
        has_product_id: id,
        store_id: store,
        pending_expires_at: expiry,
        status: eli,
      });
    }
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'hyperlocal-orm-config-'.repeat(3),
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_WRITER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  afterAll(async () => {
    await databases?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });

  const scopes: Filters['scope'][] = [
    { ids: [], global: true },
    { ids: ['1'], global: false },
    { ids: ['2', '3'], global: false },
    { ids: ['9007199254740993'], global: false },
  ];
  it('returns identical counts and pages for every scope, direction and offset', async () => {
    const reader = databases!.get('data');
    let compared = 0;
    for (const scope of scopes)
      for (const [from, to] of [
        ['2026-11-16 00:00:00', '2026-11-16 23:59:59'],
        ['2026-11-15 00:00:00', '2026-11-17 00:00:00'],
      ] as const) {
        const filters = { from, to, scope };
        const before = counts.parse((await reader.execute(oldCount(filters)))[0])[0]?.count || 0;
        expect(await hyperlocalDailyMysqlCount(reader, filters)).toBe(before);
        for (const direction of ['asc', 'desc'] as const)
          for (const [limit, offset] of [
            [70001, 0],
            [2, 0],
            [2, 2],
            [3, 4],
          ] as const) {
            const old = z
              .array(hyperlocalDailyPartialRow)
              .parse((await reader.execute(oldPage(filters, direction, limit, offset)))[0]);
            expect(
              await hyperlocalDailyMysqlPage(reader, filters, { direction, limit, offset }),
            ).toStrictEqual(old);
            compared += old.length;
          }
      }
    // The seed must actually exercise rows, not only empty pages.
    expect(compared).toBeGreaterThan(40);
  });
});
