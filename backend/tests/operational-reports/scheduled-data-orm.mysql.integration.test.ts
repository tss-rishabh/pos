import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  scheduledMysqlRows,
  scheduledSourceQuery,
} from '../../src/modules/operational-reports/scheduled-data.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/**
 * W11 characterisation: the scheduled-report DATA reads moved from raw `sql` statements to the
 * Drizzle builder. The former statement was `${scheduledSourceQuery(kind, ...)} LIMIT 70001`
 * (scheduled-data.ts at 43613a75); that exact text is the frozen oracle here, and the builder
 * rows must be strictly equal (same keys, order, JS types and nulls).
 */
const kinds = [
  'timing',
  'summary',
  'availability',
  'platform',
  'delays',
  'cancellations',
  'tickets',
] as const;
const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('scheduled report DATA reads: builder equals former raw SQL', () => {
  const schema = `pos_rewrite_scheduled_orm_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Scheduled ORM fixture requires local MySQL.');
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
    await fixture.create([
      'orders',
      'stores',
      'hyperlocal_order_log',
      'hyperlocal_to_online_order_logs',
      'hyperlocal_fd_logs',
      'hyperlocal_availability_log',
      'flag_history',
      'comments',
    ]);
    await fixture.insert('stores', { id: 1, store_name: 'Alpha' });
    await fixture.insert('stores', { id: 2, store_name: 'Beta' });
    // Order IDs compare as CAST(... AS CHAR) strings in the summary ORDER BY ('1000' < '999').
    const orders = [
      // id, location_id, type, status, created_at, is_transfer, next ids, end slot
      [999, 1, 'SW', 3, '2026-11-16 09:00:00', 1, '2,3', '2026-11-16 10:00:00'],
      [1000, 2, 'NW', 3, '2026-11-15 22:00:00', null, null, '2026-11-16 11:00:00'],
      [1001, 1, 'SW', 0, '2026-11-16 09:00:00', 0, '', '2026-11-16 12:00:00'],
      [1002, 1, 'SW', 17, '2026-11-16 09:00:00', 0, '', '2026-11-16 12:00:00'],
      [1003, 0, 'SW', 3, '2026-11-16 09:00:00', 0, '', '2026-11-16 12:00:00'],
      [1004, 1, 'HD', 3, '2026-11-16 09:00:00', 0, '', '2026-11-16 12:00:00'],
      [1005, 3, 'SW', 3, '2026-11-14 23:59:59', 0, '1', '2026-11-16 12:00:00'],
      ['9007199254740993', 2, 'SW', 5, '2026-11-16 23:59:59', 1, '1', '2026-11-16 13:00:00'],
    ] as const;
    for (const [id, location, type, status, createdAt, transfer, next, end] of orders)
      await fixture.insert('orders', {
        id,
        location_id: location,
        location_type: type,
        order_status: status,
        created_at: createdAt,
        is_transfer: transfer,
        next_location_ids: next,
        end_timeslot: end,
      });
    const logs = [
      // id, order, action, main location, updated_at
      [1, 999, 'DECLINED', 1, '2026-11-16 09:05:00'],
      [2, 999, 'ACCEPTED', 2, '2026-11-16 09:10:00'],
      [3, 1000, 'ACCEPTED', null, '2026-11-16 00:00:00'],
      [4, 1001, 'ACCEPTED', 1, '2026-11-16 10:00:00'],
      [5, 1003, 'NO_ACTION', 1, '2026-11-16 10:00:00'],
      [6, 1004, 'ACCEPTED', 1, '2026-11-16 10:00:00'],
      [7, 1005, 'ACCEPTED', 3, '2026-11-16 10:00:00'],
      [8, '9007199254740993', 'DECLINED', 2, '2026-11-16 23:59:59'],
      [9, '9007199254740993', 'ACCEPTED', 2, '2026-11-17 00:00:00'],
      [10, 4242, 'ACCEPTED', 1, '2026-11-16 11:00:00'],
      [11, 1000, 'DECLINED', 2, '2026-11-15 23:59:59'],
    ] as const;
    for (const [id, order, action, main, updated] of logs)
      await fixture.insert('hyperlocal_order_log', {
        id,
        order_id: order,
        action,
        main_location_id: main,
        updated_at: updated,
      });
    for (const [id, order, cart, threshold, availability, visible, createdAt] of [
      [1, 999, 'VALID', 'GUILTY', 'NOT_GUILTY', 1, '2026-11-16 08:00:00'],
      [2, 999, 'MIXED', 'NONE', 'GUILTY', null, '2026-11-16 08:30:00'],
      [3, 1001, 'VALID', 'GUILTY', 'GUILTY', 0, '2026-11-16 09:00:00'],
      [4, 1000, 'INVALID', 'NOT_GUILTY', 'NONE', 2, '2026-11-16 23:59:59'],
      [5, 1005, 'NONE', 'NONE', 'NONE', 1, '2026-11-17 00:00:00'],
    ] as const)
      await fixture.insert('hyperlocal_availability_log', {
        id,
        order_id: order,
        cart_type: cart,
        stock_threshold: threshold,
        store_availability: availability,
        is_slot_visible: visible,
        created_at: createdAt,
      });
    for (const [id, order, flag] of [
      [1, 999, 18],
      [2, 999, 18],
      [3, 1000, 7],
      [4, '9007199254740993', 18],
    ] as const)
      await fixture.insert('flag_history', { id, order_id: order, flag_id: flag });
    for (const [id, order, status, createdAt] of [
      [1, 999, 'finished', '2026-11-16 10:30:00'],
      [2, 999, 'finished', '2026-11-16 11:30:00'],
      [3, 1000, 'finished', '2026-11-16 10:00:00'],
      [4, '9007199254740993', 'finished', '2026-11-17 01:00:00'],
      [5, 1001, 'started', '2026-11-16 13:00:00'],
    ] as const)
      await fixture.insert('comments', {
        id,
        order_id: order,
        hl_status: status,
        created_at: createdAt,
      });
    for (const [id, order, location, platform, reason, remark, createdAt] of [
      [1, 999, 1, 'CONVERT_ONLINE', 'Stock', 'r1', '2026-11-16 08:00:00'],
      [2, '9007199254740993', 77, 'CONVERT_ONLINE', '', '', '2026-11-16 23:59:59'],
      [3, 1000, 2, 'RTO_CONVERT_ONLINE', 'Late', 'r3', '2026-11-16 09:00:00'],
      [4, 1001, 2, 'CONVERT_ONLINE', 'Late', 'r4', '2026-11-17 00:00:00'],
      [5, 1002, 1, 'CONVERT_ONLINE', 'Rider', 'r5', '2026-11-16 00:00:00'],
    ] as const)
      await fixture.insert('hyperlocal_to_online_order_logs', {
        id,
        order_id: order,
        location_id: location,
        platform,
        reason,
        remark,
        created_at: createdAt,
      });
    for (const [id, order, ticket, status, createdAt] of [
      [1, '9007199254740993', '901', 'OPEN', '2026-11-16 12:00:00'],
      [2, 999, '902', 'CLOSED', '2026-11-16 13:00:00'],
      [3, null, '903', 'PENDING', '2026-11-16 00:00:00'],
      [4, 1000, '904', 'RESOLVED', '2026-11-17 00:00:00'],
      [5, 1001, null, 'UNKNOWN', '2026-11-16 14:00:00'],
    ] as const)
      await fixture.insert('hyperlocal_fd_logs', {
        id,
        order_id: order,
        fd_ticket_id: ticket,
        fd_ticket_status: status,
        created_at: createdAt,
      });
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'scheduled-orm-config-'.repeat(3),
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

  it('returns strictly equal rows for every kind, period and includeCompleted flag', async () => {
    const reader = databases!.get('data'),
      plain = (rows: unknown[]) =>
        z
          .array(z.record(z.string(), z.unknown()))
          .parse(rows)
          .map((row) => ({ ...row }));
    let compared = 0;
    for (const period of [
      {
        from: '2026-11-16 00:00:00',
        end: '2026-11-17 00:00:00',
        windowStart: '2026-11-15 00:00:00',
      },
      {
        from: '2026-11-15 00:00:00',
        end: '2026-11-17 00:00:00',
        windowStart: '2026-11-16 00:00:00',
      },
    ])
      for (const kind of kinds)
        for (const includeCompleted of [false, true]) {
          const [before] = await reader.execute(
            sql`${scheduledSourceQuery(kind, period, includeCompleted)} LIMIT 70001`,
          );
          const old = plain(z.array(z.unknown()).parse(before)),
            current = plain(await scheduledMysqlRows(reader, kind, period, includeCompleted));
          // Timing has no ORDER BY in either form; compare it as a multiset like the source.
          const key = (row: Record<string, unknown>) => JSON.stringify(row);
          if (kind === 'timing') expect(current.map(key).sort()).toStrictEqual(old.map(key).sort());
          else expect(current).toStrictEqual(old);
          compared += old.length;
        }
    expect(compared).toBeGreaterThan(40);
  });
});
