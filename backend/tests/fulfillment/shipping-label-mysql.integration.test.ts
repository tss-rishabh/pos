import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { goldenSpawnResult } from '../golden/load.js';
import mysql from 'mysql2/promise';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { shippingAddresses } from '../../src/modules/fulfillment/shipping-label/schema.js';
import { shippingLabelService } from '../../src/modules/fulfillment/shipping-label/service.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import type { Principal } from '../../src/domain/access.js';

const integration = process.env.MYSQL_INTEGRATION_URL;
const user: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
describe.skipIf(!integration)('shipping labels on verified isolated MySQL', () => {
  const schema = 'pos_rewrite_shipping_test_' + randomUUID().replaceAll('-', '').slice(0, 12),
    tables = [
      'stores',
      'orders',
      'pos_user',
      'user_stores',
      'express_line_item',
      'has_products',
      'zones',
      'countries',
    ];
  let native: mysql.Connection | undefined,
    database: Databases | undefined,
    created = false;
  const sqlDb = () => {
      if (!native) throw new Error('Shipping fixture unavailable.');
      return native;
    },
    db = () => {
      if (!database) throw new Error('Shipping fixture unavailable.');
      return database;
    };
  const columns = z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        nullable: z.boolean(),
        collation: z.string().optional(),
        key: z.string(),
      }),
    )
    .parse(
      (
        JSON.parse(readFileSync('evidence/mysql-admin-shipping-schema.json', 'utf8')) as {
          tables: Record<string, unknown>;
        }
      ).tables.has_addresses,
    );
  const reads: { writer: number; primary: number; data: number } = {
    writer: 0,
    primary: 0,
    data: 0,
  };
  const service = () =>
    shippingLabelService({
      get: (name) => {
        reads[name]++;
        return db().get(name);
      },
      close: async () => {},
    });
  beforeAll(async () => {
    const url = new URL(integration!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_integration'
    )
      throw new Error('Shipping fixtures require the guarded local integration database.');
    native = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    await native.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await native.changeUser({ database: schema });
    await verifiedMysqlFixture(native).create(tables);
    const projection = getTableConfig(shippingAddresses);
    for (const field of projection.columns) {
      const physical = columns.find((column) => column.name === field.name);
      if (!physical || physical.type !== field.getSQLType() || physical.nullable === field.notNull)
        throw new Error('Shipping fixture projection differs from verified metadata.');
    }
    const selected = projection.columns.map((field) =>
      columns.find((column) => column.name === field.name)!,
    );
    await native.query(
      `CREATE TABLE has_addresses (${selected.map((column) => mysql.escapeId(column.name) + ' ' + column.type + (column.collation ? ' CHARACTER SET ' + mysql.escapeId(column.collation.split('_')[0]!) + ' COLLATE ' + mysql.escapeId(column.collation) : '') + (column.nullable ? ' NULL' : ' NOT NULL')).join(',')},PRIMARY KEY(id)) ENGINE=InnoDB`,
    );
    url.pathname = '/' + schema;
    database = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'shipping-label-local-fixture-'.repeat(3),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  beforeEach(async () => {
    for (const table of [...tables, 'has_addresses'])
      await sqlDb().query(`DELETE FROM ${mysql.escapeId(table)}`);
    reads.writer = reads.primary = reads.data = 0;
    const fixture = verifiedMysqlFixture(sqlDb());
    for (const id of [1, 2])
      await fixture.insert('stores', {
        id,
        store_name: 'Fixture ' + id,
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
        address: 'Fixture return road',
        alt_address: 'Annex',
        phone: '0000000000',
      });
    await fixture.insert('pos_user', { id: 1, role: 4, user_type: 1, is_active: 1 });
    await fixture.insert('user_stores', { id: 1, django_user_id: 1, store_id: 1 });
    await fixture.insert('orders', {
      id: 1001,
      has_address_id: 10,
      order_ref_no: 'FIXTURE-1001',
      created_at: '2026-11-16 10:00:00',
    });
    await fixture.insert('zones', { id: 1, name: 'Fixture zone' });
    await fixture.insert('countries', { id: 1, name: 'Fixture country' });
    await db().get('writer').insert(shippingAddresses).values({
      id: 10,
      firstName: 'Fixture',
      lastName: 'Recipient',
      flat: '3B',
      address1: 'Fixture road',
      address2: 'Level 2',
      address3: 'Landmark',
      address4: 'Area',
      city: 'Fixture city',
      postcode: '000001',
      phone: '0000000000',
      zoneId: 1,
      countryId: 1,
    });
    for (const [id, qty, awb] of [
      [501, 2, ''],
      [502, 3, 'AWB123456789012IN'],
      [503, 100, 'OTHER-STORE'],
    ] as const)
      await fixture.insert('has_products', { id, order_id: 1001, qty, awb });
    for (const [id, hp, store] of [
      [1, 501, 1],
      [2, 502, 1],
      [3, 503, 2],
      [4, 501, 1],
    ] as const)
      await fixture.insert('express_line_item', {
        id,
        order_id: 1001,
        has_product_id: hp,
        store_id: store,
        status: 'PACKED',
      });
  });
  afterAll(async () => {
    await database?.close();
    if (native && created) {
      await native.changeUser({ database: 'mysql' });
      await native.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await native?.end();
  });
  async function sourceCase() {
    const [orders] = await sqlDb().query<mysql.RowDataPacket[]>(
        'SELECT CAST(id AS CHAR) id,order_ref_no,created_at FROM orders WHERE id=1001',
      ),
      [stores] = await sqlDb().query<mysql.RowDataPacket[]>(
        'SELECT id,address,alt_address,phone FROM stores',
      ),
      [lines] = await sqlDb().query<mysql.RowDataPacket[]>(
        'SELECT id,order_id,store_id,has_product_id FROM express_line_item',
      ),
      [products] = await sqlDb().query<mysql.RowDataPacket[]>(
        "SELECT id,CAST(qty AS CHAR) qty,awb,(awb='') awb_empty FROM has_products ORDER BY id",
      );
    const [address] = await sqlDb().query<mysql.RowDataPacket[]>(
      'SELECT ha.firstname,ha.lastname,ha.flat,ha.address1,ha.address2,ha.address3,ha.address4,ha.city,ha.postcode,ha.phone_no,z.name zone_name,c.name country_name FROM orders o JOIN has_addresses ha ON ha.id=o.has_address_id LEFT JOIN zones z ON z.id=ha.zone_id LEFT JOIN countries c ON c.id=ha.country_id WHERE o.id=1001',
    );
    const fields = [
      'firstname',
      'lastname',
      'flat',
      'address1',
      'address2',
      'address3',
      'address4',
      'city',
      'postcode',
      'phone_no',
      'zone_name',
      'country_name',
    ];
    return {
      order_id: 1001,
      store_id: '1',
      orders,
      stores,
      lines,
      products,
      address: address[0] ? fields.map((field) => address[0]![field]) : null,
    };
  }
  it('matches the pinned handler context across12 native vectors, deduplicated HPs, padded AWBs, missing addresses and exact BIGINT quantities', async () => {
    const vectors: {
      source: Awaited<ReturnType<typeof sourceCase>>;
      actual: Awaited<ReturnType<ReturnType<typeof shippingLabelService>>>;
    }[] = [];
    async function capture() {
      vectors.push({ source: await sourceCase(), actual: await service()(user, '1', '1001') });
    }
    await capture();
    await sqlDb().query("UPDATE has_products SET awb='   ' WHERE id=501");
    await capture();
    await sqlDb().query("UPDATE has_products SET awb='0' WHERE id=501");
    await capture();
    await sqlDb().query("UPDATE has_products SET awb='' WHERE id IN(501,502)");
    await capture();
    await sqlDb().query("UPDATE has_addresses SET flat=NULL,address3=NULL,address4='Area only'");
    await capture();
    await sqlDb().query(
      "UPDATE has_addresses SET firstname='',lastname='',address2='',city='',postcode='',phone_no='',zone_id=99,country_id=99",
    );
    await capture();
    await sqlDb().query('UPDATE orders SET has_address_id=NULL');
    await capture();
    await sqlDb().query('UPDATE orders SET has_address_id=999');
    await capture();
    await sqlDb().query("UPDATE orders SET order_ref_no=NULL,created_at='2019-01-01 00:00:00'");
    await capture();
    await sqlDb().query('UPDATE has_products SET qty=9007199254740993 WHERE id=501');
    await capture();
    await sqlDb().query('UPDATE express_line_item SET has_product_id=NULL WHERE store_id=1');
    await capture();
    await sqlDb().query('UPDATE express_line_item SET has_product_id=502 WHERE id=1');
    await capture();
    const oracle = goldenSpawnResult(
      'fulfillment',
      'shipping-label-mysql-integration',
      JSON.stringify(vectors.map((vector) => vector.source)),
    );
    expect(oracle.status, oracle.stderr).toBe(0);
    const contexts = z
      .array(
        z.object({
          store_address: z.string(),
          shipping_addr: z
            .object({
              name: z.string(),
              address_line: z.string(),
              city_line: z.string(),
              phone_no: z.string(),
            })
            .nullable(),
          payment_mode: z.literal('Prepaid'),
          order_date: z.string(),
          product: z.literal('Cloths'),
          total_qty: z.string(),
          order_id: z.string(),
          order_ref_no: z.string().nullable(),
          awb: z.string(),
          is_store: z.literal(false),
        }),
      )
      .parse(JSON.parse(oracle.stdout) as unknown);
    vectors.forEach(({ actual }, index) => {
      const expected = contexts[index]!;
      expect(actual).toMatchObject({
        orderId: expected.order_id,
        storeAddress: expected.store_address,
        shippingAddress: expected.shipping_addr
          ? {
              name: expected.shipping_addr.name,
              addressLine: expected.shipping_addr.address_line,
              cityLine: expected.shipping_addr.city_line,
              phone: expected.shipping_addr.phone_no,
            }
          : null,
        paymentMode: expected.payment_mode,
        orderDate: expected.order_date,
        product: expected.product,
        totalQuantity: expected.total_qty,
        orderReference: expected.order_ref_no === null ? 'None' : expected.order_ref_no,
        awb: expected.awb,
      });
    });
    expect(vectors[0]!.actual.totalQuantity).toBe('5');
    expect(vectors[0]!.actual.awb).toBe('AWB123456789012IN');
    expect(vectors[1]!.actual.awb).toBe('AWB123456789012IN');
    expect(vectors[9]!.actual.totalQuantity).toBe('9007199254740996');
    expect(vectors[10]!.actual.totalQuantity).toBe('0');
    expect(reads.primary).toBe(12);
    expect(reads.data).toBe(0);
  }, 20_000);
  it('blocks absent pairs, inactive stores and missing orders before any primary address read', async () => {
    await expect(service()(user, '1', '9999')).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await sqlDb().query('DELETE FROM express_line_item WHERE store_id=1');
    await expect(service()(user, '1', '1001')).rejects.toMatchObject({
      code: 'SHIPPING_LINES_NOT_FOUND',
    });
    await sqlDb().query('UPDATE stores SET is_active=0 WHERE id=1');
    await expect(service()(user, '1', '1001')).rejects.toMatchObject({ code: 'STORE_NOT_FOUND' });
    expect(reads.primary).toBe(0);
  });
  it('checks writer-current role/type/assignment rather than stale administrator props before reading private labels', async () => {
    const stale = { ...user, role: 1 as const };
    await sqlDb().query('DELETE FROM user_stores');
    await expect(service()(stale, '1', '1001')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await sqlDb().query('INSERT INTO user_stores(id,django_user_id,store_id) VALUES(1,1,1)');
    await sqlDb().query('UPDATE pos_user SET user_type=2 WHERE id=1');
    await expect(service()(stale, '1', '1001')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await sqlDb().query("UPDATE stores SET category='FRANCHISE' WHERE id=1");
    expect((await service()({ ...user, userType: 2 }, '1', '1001')).totalQuantity).toBe('5');
    const prior = reads.primary;
    await sqlDb().query('UPDATE pos_user SET is_active=0 WHERE id=1');
    await expect(service()(stale, '1', '1001')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(reads.primary).toBe(prior);
  });
  it('fails rather than printing partial or cross-order product evidence', async () => {
    await sqlDb().query('UPDATE express_line_item SET has_product_id=999 WHERE id=1');
    await expect(service()(user, '1', '1001')).rejects.toMatchObject({
      code: 'SHIPPING_LABEL_NOT_READY',
    });
    await sqlDb().query('UPDATE express_line_item SET has_product_id=501 WHERE id=1');
    await sqlDb().query('UPDATE has_products SET order_id=1002 WHERE id=501');
    await expect(service()(user, '1', '1001')).rejects.toMatchObject({
      code: 'SHIPPING_LABEL_RECONCILIATION_REQUIRED',
    });
  });
});
