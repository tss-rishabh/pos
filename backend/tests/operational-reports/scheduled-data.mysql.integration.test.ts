import { randomUUID } from 'node:crypto';
import { goldenStdout } from '../golden/load.js';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  scheduledReportBuilder,
  scheduledSourceQuery,
  type FreshdeskReader,
} from '../../src/modules/operational-reports/scheduled-data.js';
import { scheduledReportOptions } from '../../src/modules/operational-reports/scheduled-options.js';
import {
  cancellationMessages,
  delayMessages,
  performanceMessages,
  scheduleInput,
  crmAge,
  type TimingFact,
  type SlotFact,
} from '../../src/modules/operational-reports/scheduled-domain.js';

/** Replays the pinned CPython 3.10 source oracles captured for this test (tests/golden). */
function executePosSourceOracle(args: readonly string[], options: { input?: string }): string {
  return goldenStdout('operational-reports', 'scheduled-data-mysql-integration', options.input, [
    '-B',
    ...args,
  ]);
}
const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('scheduled report queries on verified-schema local MySQL', () => {
  const schema = `pos_rewrite_scheduled_data_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    config = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'scheduled-query-mysql-'.repeat(3),
    }),
    clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
    options = scheduledReportOptions({
      BQ_HYPERLOCAL_ORDER_LOGS_VIEW: 'fixture-project.reports.logs',
      BQ_HYPERLOCAL_ORDER_FACTS_VIEW: 'fixture-project.reports.orders',
    }),
    slots: SlotFact[] = [
      {
        id: '1',
        storeId: '2',
        weekday: 'MON',
        available: true,
        start: '10:00:00',
        end: '21:00:00',
      },
    ];
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  const tickets: string[] = [];
  const crm: FreshdeskReader = async (id) => {
    tickets.push(id);
    return { status: id === '901' ? 'OPEN' : 'CLOSED', createdAt: '2026-11-15T07:00:00Z' };
  };
  function db() {
    if (!databases) throw new Error('Fixture unavailable.');
    return databases;
  }
  const build = () =>
    scheduledReportBuilder(
      config,
      db(),
      options,
      {
        async queryReport(_statement, params, _types, resource) {
          // Isolated source SQL provides the compatible-view oracle. Production
          // selects only the warehouse port for these unbounded fact cohorts.
          const period = {
            from: String(params.from),
            end: String(params.end),
            windowStart: String(params.windowStart),
          };
          const [rows] = await db()
            .get('data')
            .execute(
              scheduledSourceQuery(
                resource === 'hyperlocal-performance' ? 'timing' : 'summary',
                period,
                params.includeCompleted === true,
              ),
            );
          return z.array(z.record(z.string(), z.unknown())).parse(rows);
        },
      },
      crm,
      clock,
    );
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Scheduled data fixture requires local MySQL.');
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
      'hyperlocal_order_log',
      'stores',
      'pos_hyperlocal_slots',
      'comments',
      'hyperlocal_to_online_order_logs',
      'hyperlocal_availability_log',
      'flag_history',
      'hyperlocal_fd_logs',
    ]);
    await fixture.insert('stores', { id: 1, store_name: 'Fixture test', type: 'STORE' });
    await fixture.insert('stores', { id: 2, store_name: 'Fixture one', type: 'STORE' });
    await fixture.insert('stores', { id: 3, store_name: 'Fixture two', type: 'CORE_WAREHOUSE' });
    await fixture.insert('pos_hyperlocal_slots', {
      id: 1,
      store_id: 2,
      weekday: 'MON',
      is_avail: 1,
      start_timeslot: '10:00:00',
      end_timeslot: '21:00:00',
    });
    for (const [id, date, status, location, type] of [
      [1001, '2026-11-16 09:00:00', 3, 2, 'SW'],
      [1002, '2026-11-15 12:00:00', 3, 3, 'NW'],
      [1003, '2026-11-14 12:00:00', 3, 2, 'SW'],
      [1004, '2026-11-16 12:00:00', 0, 2, 'SW'],
      [1005, '2026-11-16 12:00:00', 3, 0, 'SW'],
    ] as const)
      await fixture.insert('orders', {
        id,
        created_at: date,
        order_status: status,
        location_id: location,
        location_type: type,
        is_transfer: id === 1002 ? 1 : null,
        next_location_ids: id === 1002 ? '[2,2]' : null,
        start_timeslot: '2026-11-16 10:00:00',
        end_timeslot: '2026-11-16 12:00:00',
      });
    for (const [id, order, action, time] of [
      [1, 1001, 'ACCEPTED', '2026-11-16 11:00:00'],
      [2, 1001, 'DECLINED', '2026-11-16 12:00:00'],
      [3, 1002, 'DECLINED', '2026-11-16 13:00:00'],
      [4, 1003, 'ACCEPTED', '2026-11-16 14:00:00'],
      [5, 1004, 'ACCEPTED', '2026-11-16 11:00:00'],
    ] as const)
      await fixture.insert('hyperlocal_order_log', {
        id,
        order_id: order,
        action,
        created_at: '2026-11-15 11:00:00',
        updated_at: time,
        main_location_id: null,
      });
    await fixture.insert('comments', {
      order_id: 1001,
      hl_status: 'finished',
      created_at: '2026-11-16 12:05:59',
    });
    await fixture.insert('comments', {
      order_id: 1001,
      hl_status: 'finished',
      created_at: '2026-11-16 13:30:00',
    });
    await fixture.insert('comments', {
      order_id: 1002,
      hl_status: 'finished',
      created_at: '2026-11-16 14:00:00',
    });
    await fixture.insert('hyperlocal_to_online_order_logs', {
      order_id: '9007199254740993',
      new_order_id: '9007199254740994',
      location_id: 2,
      platform: 'CONVERT_ONLINE',
      reason: 'Fixture reason',
      remark: 'Fixture remark',
      created_at: '2026-11-16 23:59:59',
    });
    await fixture.insert('hyperlocal_to_online_order_logs', {
      order_id: 1002,
      new_order_id: 1003,
      location_id: 2,
      platform: 'RTO_CONVERT_ONLINE',
      created_at: '2026-11-16 10:00:00',
    });
    for (const [id, order, cart, stock, store, visible] of [
      [1, 1001, 'VALID', 'NOT_GUILTY', 'NOT_GUILTY', 1],
      [2, 1001, 'VALID', 'NOT_GUILTY', 'NOT_GUILTY', 1],
      [3, 1002, 'MIXED', 'GUILTY', 'NOT_GUILTY', 0],
      [4, 1004, 'INVALID', 'NONE', 'NONE', null],
      [5, 1005, 'INVALID', 'NONE', 'NONE', null],
    ] as const)
      await fixture.insert('hyperlocal_availability_log', {
        id,
        order_id: order,
        cart_type: cart,
        stock_threshold: stock,
        store_availability: store,
        is_slot_visible: visible,
        created_at: '2026-11-16 12:00:00',
      });
    await fixture.insert('flag_history', { order_id: 1001, flag_id: 18 });
    await fixture.insert('flag_history', { order_id: 1001, flag_id: 18 });
    await fixture.insert('hyperlocal_fd_logs', {
      id: 1,
      order_id: '9007199254740993',
      fd_ticket_id: '901',
      fd_ticket_status: 'OPEN',
      created_at: '2026-11-16 00:00:00',
    });
    await fixture.insert('hyperlocal_fd_logs', {
      id: 2,
      order_id: 1001,
      fd_ticket_id: '902',
      fd_ticket_status: 'OPEN',
      created_at: '2026-11-16 23:59:59',
    });
    await fixture.insert('hyperlocal_fd_logs', {
      id: 3,
      order_id: 1002,
      fd_ticket_id: '903',
      fd_ticket_status: 'CLOSED',
      created_at: '2026-11-16 12:00:00',
    });
    await fixture.insert('hyperlocal_fd_logs', {
      id: 4,
      order_id: '9007199254740993',
      fd_ticket_id: '901',
      fd_ticket_status: 'OPEN',
      created_at: '2026-11-15 12:00:00',
    });
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'scheduled-data-config-'.repeat(3),
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
  async function source(kind: 'timing' | 'delays' | 'cancellations' | 'tickets' | 'availability') {
    const query = executePosSourceOracle(
        [
          'tools/operational-reports/scheduled-query-oracle.py',
          kind,
          '2026-11-16 00:00:00',
          '2026-11-16 23:59:59',
        ],
        { encoding: 'utf8' },
      ),
      [mode] = await admin!.query<mysql.RowDataPacket[]>('SELECT @@SESSION.sql_mode AS value'),
      original = String(mode[0]?.value || '');
    try {
      await admin!.query('SET SESSION sql_mode=?', [
        original
          .split(',')
          .filter((value) => value !== 'ONLY_FULL_GROUP_BY')
          .join(','),
      ]);
      return (await admin!.query<mysql.RowDataPacket[]>(query))[0];
    } catch {
      throw new Error('Original scheduled fixture query failed.');
    } finally {
      await admin!.query('SET SESSION sql_mode=?', [original]);
    }
  }
  it('matches original timing/delivery/cancellation selections with strict grouping and lossless IDs', async () => {
    const builder = build(),
      timing = (await source('timing')).map((row) => ({
        orderId: String(row.OrderId),
        createdAt: String(row.CreatedAt),
        storeId: row.StoreID === null ? null : String(row.StoreID),
        storeName: row.StoreName === null ? null : String(row.StoreName),
        acceptedAt: String(row.AcceptedAt),
      })) satisfies TimingFact[],
      delay = (await source('delays')).map((row) => ({
        orderId: String(row.OrderId),
        totalDelay: String(row.TotalDelay),
      })),
      cancelled = (await source('cancellations')).map((row) => ({
        orderId: String(row.OrderID),
        storeName: row.StoreName === null ? null : String(row.StoreName),
        reason: row.Reason === null ? null : String(row.Reason),
        comment: row.Comment === null ? null : String(row.Comment),
        convertedAt: String(row.ConvertedAt),
      }));
    expect(
      await builder({
        ...scheduleInput.parse({ kind: 'hyperlocal-performance' }),
        date: '2026-11-16',
      }),
    ).toEqual(performanceMessages('2026-11-16', timing, slots));
    expect(
      await builder({
        ...scheduleInput.parse({ kind: 'hyperlocal-delivery-delays' }),
        date: '2026-11-16',
      }),
    ).toEqual(delayMessages('2026-11-16', delay));
    const cancellations = await builder({
      ...scheduleInput.parse({ kind: 'hyperlocal-cancellations' }),
      date: '2026-11-16',
    });
    expect(cancellations).toEqual(cancellationMessages('2026-11-16', cancelled));
    expect(cancellations.messages[0]?.text).toContain('9007199254740993');
  });
  it('batches first-log summary, duplicate eligibility/platform counts and current store configuration', async () => {
    const builder = build(),
      summary = await builder({
        ...scheduleInput.parse({ kind: 'hyperlocal-summary' }),
        date: '2026-11-16',
      });
    expect(summary.recordCount).toBe(2);
    expect(summary.messages[0]?.text).toContain(
      'Accepted: ` 1 ` |  ' + String.fromCodePoint(0x274c) + ' Declined: ` 2`',
    );
    expect(summary.messages[0]?.text).toContain('Total Orders:* ` 2 `');
    const available = await builder({
      ...scheduleInput.parse({ kind: 'hyperlocal-availability' }),
      date: '2026-11-16',
    });
    expect(available.recordCount).toBe(4);
    expect(available.messages[0]?.text).toContain('(A):* `2` | *APP:* `1` | *WEB:* `0`');
    expect(available.messages[0]?.text).toContain('(B):* `1` | *APP:* `1` | *WEB:* `0`');
    expect(available.messages[0]?.text).toContain('buffer inventory:* `1`');
    const status = await builder({
      ...scheduleInput.parse({ kind: 'hyperlocal-store-status' }),
      date: '2026-11-16',
    });
    expect(status.messages[0]?.text).toContain('eligible for hyperlocal configuration:* `2`');
    expect(status.messages[0]?.text).toContain('pending hyperlocal configuration:* `1`');
  });
  it('refreshes authoritative CRM records after bounded external GETs and preserves source all-ticket updates', async () => {
    const selected = await source('tickets');
    expect(selected.map((row) => String(row.fd_ticket_id))).toEqual(['901', '902']);
    const result = await build()({
      ...scheduleInput.parse({ kind: 'crm-tickets' }),
      date: '2026-11-16',
    });
    expect(tickets).toEqual(['901', '902']);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.text).toContain('9007199254740993');
    expect(result.messages[0]?.text).not.toContain('902        |');
    const [rows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT fd_ticket_status,fd_ticket_age FROM hyperlocal_fd_logs WHERE fd_ticket_id=?',
      ['901'],
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.fd_ticket_status === 'OPEN' &&
          row.fd_ticket_age === crmAge('2026-11-15T07:00:00Z', clock()).milliseconds,
      ),
    ).toBe(true);
    const [closed] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT fd_ticket_status FROM hyperlocal_fd_logs WHERE fd_ticket_id=?',
      ['902'],
    );
    expect(closed[0]?.fd_ticket_status).toBe('CLOSED');
  });
  it('treats archived CRM rows as candidates and rechecks writer-current tickets after the external lookup', async () => {
    const calls: string[] = [],
      roles: string[] = [],
      wrapped: Databases = {
        get(role) {
          roles.push(role);
          return db().get(role);
        },
        close: async () => {},
      },
      builder = scheduledReportBuilder(
        config,
        wrapped,
        { ...options, BQ_HYPERLOCAL_CRM_TICKETS_VIEW: 'fixture-project.reports.crm_tickets' },
        {
          async queryReport() {
            return [
              { orderId: '9007199254740993', ticketId: '901', createdAt: '2026-11-16 00:00:00' },
              { orderId: '1001', ticketId: '999', createdAt: '2026-11-16 00:00:00' },
            ];
          },
        },
        async (id) => {
          calls.push(id);
          await admin!.query(
            "UPDATE hyperlocal_fd_logs SET fd_ticket_status='CLOSED' WHERE fd_ticket_id=?",
            [id],
          );
          return { status: 'OPEN', createdAt: '2026-11-15T07:00:00Z' };
        },
        () => Temporal.Instant.from('2026-11-17T08:00:00Z'),
      );
    const result = await builder({
      ...scheduleInput.parse({ kind: 'crm-tickets' }),
      date: '2026-11-16',
    });
    expect(calls).toEqual(['901']);
    expect(roles).toEqual(['writer']);
    expect(result.recordCount).toBe(0);
    expect(result.messages.map((message) => message.target)).toEqual(['demo']);
    const [rows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT fd_ticket_status FROM hyperlocal_fd_logs WHERE fd_ticket_id=?',
      ['901'],
    );
    expect(rows.every((row) => row.fd_ticket_status === 'CLOSED')).toBe(true);
  });
});
