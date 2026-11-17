import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.js';
import {
  membershipFixtureOrder,
  membershipHistoryScope,
  type MembershipFixtureOrder,
} from '../../tests/legacy-order-imports/membership-bigquery-fixtures.js';

export async function membershipPublicationFixture(connection: string) {
  const input = new URL(connection);
  if (input.protocol !== 'mysql:' || !['localhost', '127.0.0.1'].includes(input.hostname))
    throw new Error('Membership publication tests require isolated local MySQL.');
  const schema = 'pos_membership_pub_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const admin = await mysql.createConnection({
    host: input.hostname,
    port: Number(input.port || 3306),
    user: decodeURIComponent(input.username),
    password: decodeURIComponent(input.password),
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  await admin.query('CREATE DATABASE ' + mysql.escapeId(schema));
  try {
    await admin.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(admin, ['evidence/mysql-customer-contact-schema.json']);
    await fixture.create(['orders', 'has_products']);
    await admin.query(
      'CREATE INDEX fixture_member_customer_date ON orders(user_id,order_status,created_at,id)',
    );
    await admin.query('CREATE INDEX fixture_member_order_line ON has_products(order_id,id)');
    const [raw] = await admin.query('SELECT @@GLOBAL.server_uuid AS uuid');
    const sourceServerUuid = z.array(z.object({ uuid: z.uuid() })).parse(raw)[0]!.uuid;
    input.pathname = '/' + schema;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-membership-publication-'.repeat(3),
      MYSQL_WRITER_URL: input.href,
      MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/forbidden_membership_primary_reader',
      MYSQL_DATA_READER_URL: 'mysql://root@127.0.0.1/forbidden_membership_data_reader',
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_POOL_SIZE: '4',
    });
    const db = createDatabases(config);
    const seed = async (rows: MembershipFixtureOrder[]) => {
      for (const row of rows) {
        await fixture.insert('orders', {
          id: row.id,
          user_id: row.customerId,
          payment_method: row.paymentMethod,
          payment_status: row.paymentStatus,
          order_status: row.orderStatus,
          created_at: row.createdAt,
          updated_at: row.createdAt,
        });
        for (const line of row.lines)
          await fixture.insert('has_products', {
            id: line.lineId,
            order_id: row.id,
            prod_id: line.productId,
            is_exclusive_order: line.isExclusiveOrder,
            created_at: row.createdAt,
            updated_at: row.createdAt,
          });
      }
    };
    return {
      admin,
      db,
      config,
      schema,
      sourceServerUuid,
      seed,
      fixture,
      async reset() {
        await admin.query('DELETE FROM has_products');
        await admin.query('DELETE FROM orders');
        await seed([membershipFixtureOrder()]);
      },
      async close() {
        await db.close();
        await admin.changeUser({ database: 'mysql' });
        await admin.query('DROP DATABASE ' + mysql.escapeId(schema));
        await admin.end();
      },
    };
  } catch (error) {
    await admin.changeUser({ database: 'mysql' });
    await admin.query('DROP DATABASE ' + mysql.escapeId(schema));
    await admin.end();
    throw error;
  }
}
export const publicationCustomerId = membershipHistoryScope.customerId;
