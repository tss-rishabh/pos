import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { fulfillmentService } from '../../src/modules/fulfillment/service.js';
import { fulfillmentEffects } from '../../src/modules/fulfillment/effects.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import type { CheckInReader } from '../../src/modules/fulfillment/checkin.js';
import { createOrderNotification } from '../../src/modules/fulfillment/notifications.js';
import type { NoticeEvent } from '../../src/modules/fulfillment/notification-bus.js';
import { createProductionTables } from '../helpers/production-schema.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

/**
 * Pinned notification workflow (78d5b63): `helpers/notification_helpers.py:13-57`
 * (create_order_notification_sync, order_notification), `notification/consumers.py`
 * (NotificationConsumer.send_notification), `notification/views.py` (AjaxNotificationUpdateView)
 * and `core/context_processors.py:32-35` (get_users_notification), executed on a private copy
 * of this fixture and replayed from `tests/golden/fulfillment/notification-workflow.json`.
 * The browser half of the former native workflow (audio, header rendering, live socket) is not
 * captured.
 */
const connection = process.env.MYSQL_INTEGRATION_URL;
const checkIns: Record<string, string[]> = { '1': ['7', '8'], '2': ['9'] };
const checkedInStore: Record<string, string> = { '7': '1', '8': '1', '9': '2' };
const publishes = [
  { title: 'New order received', orderId: '1001', storeId: '1', isNewOrder: true },
  {
    title: 'Order transferred',
    orderId: '1002',
    storeId: '1',
    isNewOrder: false,
    reason: 'Out of stock',
  },
  { title: 'New order received', orderId: '1003', storeId: '2', isNewOrder: true },
  { title: 'Ignored zero order', orderId: '0', storeId: '1', isNewOrder: false },
  { title: 'Unknown store order', orderId: '1004', storeId: '3', isNewOrder: false },
] as const;
const publishAt = '2026-11-17T11:30:20';
const dispatchAt = '2026-11-17T11:35:00';
const steps = [
  ...publishes.map((step) => ({ op: 'publish', now: publishAt, ...step })),
  { op: 'dispatch', now: dispatchAt, actor: '7', serialized: 'noti_id=1' },
  { op: 'dispatch', now: dispatchAt, actor: '8', serialized: '' },
  { op: 'dispatch', now: dispatchAt, actor: null, serialized: 'noti_id=1' },
  { op: 'dispatch', now: dispatchAt, actor: '9', serialized: 'noti_id=3' },
  { op: 'dispatch', now: dispatchAt, actor: '7', serialized: 'noti_id=3' },
  { op: 'list', now: dispatchAt, actor: '7', storeId: '1' },
  { op: 'list', now: dispatchAt, actor: '8', storeId: '1' },
  { op: 'list', now: dispatchAt, actor: '9', storeId: '2' },
];
const wsPayload = z
  .object({
    title: z.string(),
    noti_id: z.number(),
    // json.dumps of the caller's value: the strings passed here, as request-derived callers do.
    order_id: z.union([z.string(), z.number()]),
    store_id: z.union([z.string(), z.number()]),
    users: z.array(z.number()),
    is_new_order: z.boolean(),
  })
  .strict();
const row = z.record(z.string(), z.string().nullable());
const legacySchema = z.object({
  steps: z.array(
    z.discriminatedUnion('op', [
      z.object({
        op: z.literal('publish'),
        received: z.array(z.object({ event: z.unknown(), websocket: z.array(wsPayload) })),
      }),
      z.object({
        op: z.literal('dispatch'),
        status: z.number(),
        body: z.object({ status: z.string(), message: z.string() }).nullable(),
        location: z.string().nullable(),
      }),
      z.object({
        op: z.literal('list'),
        unread: z.number(),
        rows: z.array(z.object({ notificationId: z.string(), isViewed: z.number() })),
      }),
    ]),
  ),
  tables: z.object({ pos_notifications: z.array(row), pos_user_notifications: z.array(row) }),
});
const instant = (wall: string) =>
  Temporal.PlainDateTime.from(wall).toZonedDateTime('Asia/Kolkata').toInstant();
const principal = (id: string): Principal => ({
  id,
  name: 'Synthetic operator ' + id,
  email: '',
  role: 4,
  userType: 1,
  storeIds: ['1', '2'],
});

describe.skipIf(!connection)('pinned notification workflow against the rewrite on MySQL', () => {
  const schema = 'pos_rewrite_notification_workflow_' + randomBytes(6).toString('hex');
  let admin: mysql.Connection | undefined, databases: Databases | undefined, url: string;
  let legacy: z.infer<typeof legacySchema>;
  beforeAll(async () => {
    const base = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(base.hostname))
      throw new Error('Notification fixtures require a local MySQL host.');
    admin = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
      dateStrings: true,
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await admin.changeUser({ database: schema });
    await createProductionTables(admin, [
      'pos_notifications',
      'pos_user_notifications',
      'stores',
      'pos_user',
    ]);
    for (const [id, name, phone] of [
      [1, 'Synthetic one', '9000000101'],
      [2, 'Synthetic two', '9000000102'],
    ] as const)
      await admin.query(
        "INSERT INTO stores (id,store_name,phone,is_active,type,location_code,category) VALUES (?,?,?,1,'STORE',?, 'IN_HOUSE')",
        [id, name, phone, 'L' + id],
      );
    for (const id of [7, 8, 9])
      await admin.query(
        "INSERT INTO pos_user (id,username,password,email,is_active,role,user_type) VALUES (?,?,'unused',?,1,4,1)",
        [id, 'operator' + id, 'operator' + id + '@example.invalid'],
      );
    base.pathname = '/' + schema;
    url = base.href;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'notification-workflow-local-'.repeat(3),
        MYSQL_WRITER_URL: url,
        MYSQL_PRIMARY_READER_URL: url,
        MYSQL_DATA_READER_URL: url,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
    );
    legacy = legacySchema.parse(
      JSON.parse(
        goldenStdout(
          'fulfillment',
          'notification-workflow',
          JSON.stringify({ url, checkIns, steps }),
          undefined,
          fixturePlaceholders(url),
        ),
      ) as unknown,
    );
  });
  afterAll(async () => {
    await databases?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await admin?.end();
  });

  it('writes the same notification rows, recipients, read receipts and lists as the pinned helpers', async () => {
    const db = databases!;
    let now = instant(publishAt);
    const clock = () => now;
    const checkins: CheckInReader = {
      checkedInStore: async (userId) => checkedInStore[userId] ?? null,
      checkedInUsers: async (storeId) => checkIns[storeId] ?? [],
    };
    const published: NoticeEvent[] = [];
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'notification-workflow-local-'.repeat(3),
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    const options = readFulfillmentOptions({});
    const effects = fulfillmentEffects(db, options, {
      fetch: () => Promise.reject(new Error('No outbound call is expected.')),
    });
    const service = fulfillmentService(config, db, options, { checkins, effects, clock });
    const legacySteps = legacy.steps;

    // Publish: legacy group_send reaches every socket in `notification_order` with the title;
    // the rewrite bus carries the same id/store/recipients/isNewOrder to the scoped stream only
    // (documented divergence: no cross-store title broadcast, clients re-read the list).
    for (const [index, input] of publishes.entries()) {
      const before = published.length;
      const result = await createOrderNotification(
        {
          config,
          db,
          checkins,
          effects,
          clock,
          bus: { publish: async (e) => void published.push(e) },
        },
        input,
      );
      const step = legacySteps[index]!;
      if (step.op !== 'publish') throw new Error('Unexpected legacy step order.');
      if (input.orderId === '0') {
        expect(result, 'legacy int(order_id) > 0 guard').toBeNull();
        expect(step.received).toEqual([]);
        continue;
      }
      expect(step.received).toHaveLength(1);
      const sent = step.received[0]!.websocket;
      expect(sent).toHaveLength(1);
      const legacyPayload = sent[0]!;
      expect(published.slice(before)).toEqual([
        {
          event: 'notification.created',
          notificationId: String(legacyPayload.noti_id),
          storeId: String(legacyPayload.store_id),
          userIds: legacyPayload.users.map(String),
          isNewOrder: legacyPayload.is_new_order,
        },
      ]);
      expect(result).toEqual({ notificationId: String(legacyPayload.noti_id) });
      expect(String(legacyPayload.order_id)).toBe(input.orderId);
    }

    // Dispatch: legacy AjaxNotificationUpdateView vs the rewrite read receipt.
    now = instant(dispatchAt);
    const dispatch = legacySteps.slice(publishes.length, publishes.length + 5);
    expect(
      dispatch.map((step) => (step.op === 'dispatch' ? [step.status, step.body] : null)),
    ).toEqual([
      [200, { status: 'success', message: 'Recorded' }],
      [200, { status: 'fail', message: 'Provide the id' }],
      [302, null],
      [200, { status: 'success', message: 'Recorded' }],
      [200, { status: 'success', message: 'Recorded' }],
    ]);
    await expect(service.markNotificationRead(principal('7'), '1', '1')).resolves.toEqual({
      status: 'success',
      message: 'Recorded',
    });
    // Missing noti_id: the rewrite route requires the id path parameter (no "Provide the id").
    // Anonymous: the rewrite answers 401 instead of the legacy 302 to `login` (S4).
    await expect(service.markNotificationRead(principal('9'), '2', '3')).resolves.toEqual({
      status: 'success',
      message: 'Recorded',
    });
    // Legacy records "success" for an operator who is not checked into the notification's store
    // (a no-op there); the rewrite refuses with 403 CHECK_IN_REQUIRED (documented divergence).
    await expect(service.markNotificationRead(principal('7'), '2', '3')).rejects.toMatchObject({
      status: 403,
      code: 'CHECK_IN_REQUIRED',
    });

    // List: legacy get_users_notification (top ten by -notification, unread count).
    for (const step of legacySteps.slice(publishes.length + 5)) {
      if (step.op !== 'list') throw new Error('Unexpected legacy step order.');
    }
    const lists = legacySteps.slice(publishes.length + 5);
    for (const [index, [actor, store]] of [
      ['7', '1'],
      ['8', '1'],
      ['9', '2'],
    ].entries()) {
      const expected = lists[index]!;
      if (expected.op !== 'list') throw new Error('Unexpected legacy step order.');
      const actual = await service.notifications(principal(actor!), store!, '0', 10);
      expect(
        actual.data.map((item) => ({ notificationId: item.id, isViewed: item.isViewed ? 1 : 0 })),
      ).toEqual(expected.rows);
      expect(actual.unreadCount).toBe(expected.unread);
    }

    // Final table state, column for column.
    for (const table of ['pos_notifications', 'pos_user_notifications'] as const) {
      const [rows] = await admin!.query<mysql.RowDataPacket[]>(
        `SELECT * FROM ${mysql.escapeId(table)} ORDER BY id`,
      );
      expect(
        rows.map((value) =>
          Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, item === null ? null : String(item)]),
          ),
        ),
        table,
      ).toEqual(legacy.tables[table]);
    }
  });
});
