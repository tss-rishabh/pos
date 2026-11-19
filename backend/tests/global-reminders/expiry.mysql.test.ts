import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { fulfillmentService } from '../../src/modules/fulfillment/service.js';
import { fulfillmentEffects } from '../../src/modules/fulfillment/effects.js';
import { redisCheckIns } from '../../src/modules/fulfillment/checkin.js';
import { memoryOrderRedis } from '../../src/modules/fulfillment/order-redis.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import { createProductionSchema } from '../helpers/production-schema.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const template = process.env.MYSQL_INTEGRATION_URL;
const now = '2026-11-16T08:00:00Z'; // 13:30:00 in Asia/Kolkata
const alert = z.object({
  order_id: z.number(),
  type: z.enum(['pending', 'accepted']),
  expires_at: z.string(),
});
const source = z.object({
  routeId: z.literal('order/urls.py:107'),
  body: z.union([
    z
      .object({
        expiring_soon: z.array(alert),
        banner_counts: z.object({
          unaccepted: z.number(),
          unpacked: z.number(),
          packed: z.number(),
        }),
      })
      .strict(),
    z.object({ expiring_soon: z.array(alert).length(0) }).strict(),
  ]),
});
const operator: Principal = {
  id: '1',
  role: 4,
  userType: 1,
  storeIds: ['1'],
  name: 'Synthetic operator',
  email: '',
};
/**
 * Pinned `order/views.py:5356 AjaxHyperlocalExpiryAlertsView` and `_hl_get_tab_counts`
 * (78d5b63) dispatched through Django 4.2.5 over this native fixture, replayed from
 * `tests/golden/global-reminders/expiry-native.json`.
 */
describe.skipIf(!template)('hyperlocal expiry reminders against the pinned Django view', () => {
  let connection: mysql.Connection, db: ReturnType<typeof createDatabases>, url: string;
  const schema = 'pos_rewrite_reminders_' + randomBytes(6).toString('hex');
  const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'synthetic-reminders-fixture-'.repeat(3),
  });
  beforeAll(async () => {
    const base = new URL(template!);
    if (base.protocol !== 'mysql:' || !['127.0.0.1', 'localhost'].includes(base.hostname))
      throw new Error('Use an isolated loopback MySQL template.');
    connection = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
    });
    await createProductionSchema(connection, schema, [
      'express_line_item',
      'orders',
      'has_products',
      'pos_user',
    ]);
    await connection.query(
      "INSERT INTO pos_user (id,password,username,role,is_active) VALUES (1,'!','synthetic-operator',4,1)",
    );
    // [id, order, store, status, pending_expires_at, accepted_expires_at]
    const lines: [number, number, number, string, string | null, string | null][] = [
      [1, 101, 1, 'PENDING', '2026-11-16 13:40:00', null],
      [2, 101, 1, 'PENDING', '2026-11-16 13:50:00', null],
      [3, 102, 1, 'PENDING', '2026-11-16 14:05:00', null],
      [4, 103, 1, 'PENDING', '2026-11-16 14:05:01', null],
      [5, 104, 1, 'PENDING', '2026-11-16 13:29:59', null],
      [6, 110, 1, 'PENDING', '2026-11-16 13:30:00', null],
      [7, 105, 1, 'ACCEPTED', null, '2026-11-16 13:45:00'],
      [8, 105, 1, 'ACCEPTED', null, '2026-11-16 13:44:00'],
      [9, 106, 1, 'PACKED', null, '2026-11-16 13:35:00'],
      [10, 107, 1, 'OUT_FOR_DELIVERY', null, '2026-11-16 16:00:00'],
      [11, 108, 2, 'PENDING', '2026-11-16 13:41:00', null],
      [12, 109, 1, 'ACCEPTED', null, '2026-11-17 00:10:00'],
      [13, 111, 1, 'ACCEPTED', null, '2026-11-16 23:59:59'],
    ];
    for (const [id, order, store, status, pending, accepted] of lines)
      await connection.query(
        `INSERT INTO express_line_item (id,order_id,has_product_id,store_id,status,pending_expires_at,
         accepted_expires_at,created_at) VALUES (?,?,?,?,?,?,?,'2026-11-16 12:00:00')`,
        [id, order, id, store, status, pending, accepted],
      );
    base.pathname = '/' + schema;
    url = base.href;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'synthetic-reminders-fixture-'.repeat(3),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url,
        MYSQL_PRIMARY_READER_URL: url,
        MYSQL_DATA_READER_URL: url,
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
    );
  }, 30000);
  afterAll(async () => {
    await db?.close();
    await connection?.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await connection?.end();
  });
  function legacy(checkIn: [number, string] | null) {
    return source.parse(
      JSON.parse(
        goldenStdout(
          'global-reminders',
          'expiry-native',
          JSON.stringify({ database: url, now, actor: 1, checkIn }),
          undefined,
          fixturePlaceholders(url),
        ),
      ) as unknown,
    ).body;
  }
  it('lists the same 35-minute window, per-order minimum, ordering and banner counts', async () => {
    const expected = legacy([1, 'Synthetic store']);
    if (!('banner_counts' in expected)) throw new Error('Checked-in legacy body expected.');
    const service = fulfillmentService(config, db, readFulfillmentOptions({}), {
      checkins: redisCheckIns(memoryOrderRedis()),
      effects: fulfillmentEffects(db, readFulfillmentOptions({}), {
        fetch: () => Promise.reject(new Error('No outbound calls in this test.')),
      }),
      clock: () => Temporal.Instant.from(now),
    });
    const actual = await service.expiryAlerts(operator, '1');
    expect(
      actual.expiringSoon.map((item) => ({
        order_id: Number(item.orderId),
        type: item.type,
        // Legacy datetime.isoformat(); the rewrite carries the MySQL DATETIME text.
        expires_at: item.expiresAt.replace(' ', 'T'),
      })),
    ).toEqual(expected.expiring_soon);
    expect(actual.bannerCounts).toEqual(expected.banner_counts);
  });
  it('answers an operator without a check-in with an empty legacy list', () => {
    // The rewrite route instead requires a current check-in (requireCurrentCheckIn) and
    // refuses with an explicit error; legacy silently returns no reminders.
    expect(legacy(null)).toEqual({ expiring_soon: [] });
  });
});
