/**
 * Builds a disposable loopback MySQL schema for verifying the live read-only suite without
 * production: every snapshot table, created byte-for-byte from
 * `tests/golden/schema/production-schema.json`, plus a few synthetic rows (no real data).
 *
 * Refuses any host other than loopback and any schema not named `pos_live_readonly_*`.
 *
 * Usage: node --import tsx tools/live-readonly/seed-loopback.ts \
 *   mysql://root@127.0.0.1:<port>/pos_live_readonly_fixture
 */
import { fileURLToPath } from 'node:url';
import { Temporal } from '@js-temporal/polyfill';
import mysql from 'mysql2/promise';
import { productionTableNames } from '../../tests/helpers/production-schema.js';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.js';

export async function seedLoopback(target: string): Promise<void> {
  const url = new URL(target);
  const schema = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('The loopback fixture only runs against a local MySQL server.');
  if (!/^pos_live_readonly_[a-z0-9_]{1,40}$/.test(schema))
    throw new Error('The loopback fixture schema must be named pos_live_readonly_*.');
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create(productionTableNames());
    const now = Temporal.Now.zonedDateTimeISO('Asia/Kolkata').subtract({ minutes: 30 });
    const local = (value: Temporal.ZonedDateTime) =>
      value.toPlainDateTime().toString({ smallestUnit: 'second' }).replace('T', ' ');
    const placed = local(now),
      earlier = local(now.subtract({ minutes: 10 }));
    await fixture.insert('stores', {
      id: 1,
      store_name: 'Synthetic Store',
      location_code: 'SYN1',
      type: 'STORE',
      category: 'COCO',
      is_active: 1,
      city_name: 'Synthetic City',
    });
    await fixture.insert('store_counters', {
      id: 1,
      store_id: 1,
      counter_name: 'Counter 1',
      is_active: 1,
    });
    await fixture.insert('pos_user', {
      id: 1,
      username: 'synthetic-admin',
      password: 'synthetic-not-a-password-hash',
      role: 1,
      user_type: 1,
      is_active: 1,
      date_joined: earlier,
    });
    await fixture.insert('user_stores', { id: 1, django_user_id: 1, store_id: 1 });
    await fixture.insert('users', {
      id: 10,
      firstname: 'Synthetic',
      lastname: 'Customer',
      email: 'customer@example.invalid',
      telephone: '9000000000',
      status: 1,
    });
    for (const [id, name, stock] of [
      [100, 'Synthetic Tee', 5],
      [101, 'Synthetic Joggers', 3],
    ] as const) {
      await fixture.insert('products', {
        id,
        product: name,
        erp_product: `ERP-${id}`,
        parent_prod_id: 0,
        prod_type: 1,
        price: 999,
        spl_price: 799,
        gst: 12,
        is_del: 0,
      });
      await fixture.insert('product_store', {
        product_id: id,
        store_id: 1,
        stock,
        is_avail: 1,
        is_del: 0,
      });
    }
    await fixture.insert('products_gs1', { product_id: 100, gtin: '8901234567890' });
    await fixture.insert('pricelist', { product_id: 100, pricelist_id: 2, price: 699 });
    await fixture.insert('order_status', { id: 1, display_name: 'Complete' });
    await fixture.insert('payment_status', { id: 1, payment_status: 'Paid' });
    await fixture.insert('payment_method', { id: 1, name: 'Cash' });
    for (const [id, location] of [
      [1000, null],
      [1001, null],
    ] as const)
      await fixture.insert('orders', {
        id,
        user_id: 10,
        order_ref_no: `SYN-${id}`,
        order_amt: 799,
        pay_amt: 799,
        order_status: 1,
        payment_status: 1,
        payment_method: 1,
        first_name: 'Synthetic',
        last_name: 'Customer',
        location_id: location,
        created_at: placed,
        updated_at: placed,
      });
    await fixture.insert('order_stores', {
      id: 1,
      order_id: 1000,
      store_id: 1,
      counter_id: 1,
      admin_user_id: 1,
      offline_payment: 799,
    });
    for (const [id, order, product] of [
      [1, 1000, 100],
      [2, 1001, 101],
    ] as const)
      await fixture.insert('has_products', {
        id,
        order_id: order,
        prod_id: product,
        qty: 1,
        price: 799,
        pg_disc: 0,
        store_disc_pg: 0,
        status: 'Complete',
        created_at: placed,
        updated_at: placed,
      });
    await fixture.insert('hyperlocal_order_log', {
      order_id: 1001,
      action: 'ACCEPTED',
      created_at: placed,
      updated_at: placed,
    });
  } finally {
    await connection.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write(
      'usage: seed-loopback.ts mysql://user@127.0.0.1:<port>/pos_live_readonly_<name>\n',
    );
    process.exitCode = 2;
  } else
    seedLoopback(target).then(
      () => process.stdout.write('loopback fixture ready\n'),
      (error: unknown) => {
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
        process.stderr.write(`loopback fixture failed: ${code}\n`);
        process.exitCode = 1;
      },
    );
}
