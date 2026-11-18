import mysql from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { eq } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  ExpressLineItem,
  ExpressOrderStatusLog,
  HasProduct,
  HyperlocalRejectionReason,
  Notification,
  Order,
  OrderStatus,
  PaymentStatus,
  Product,
  PosUser,
  UserStore,
  Store,
  UsersNotification,
} from '../../src/db/legacy-schema.js';
import { fulfillmentService } from '../../src/modules/fulfillment/service.js';
import { fulfillmentOutbox, type EffectDelivery } from '../../src/modules/fulfillment/outbox.js';
import { fulfillmentEffects } from '../../src/modules/fulfillment/schema.js';
import { notificationBus } from '../../src/modules/fulfillment/notification-bus.js';
import { notificationDelivery } from '../../src/modules/fulfillment/notifications.js';
import type { Principal } from '../../src/domain/access.js';
import { fulfillmentMaintenance } from '../../src/modules/fulfillment/maintenance.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import { fulfillmentMonitoring } from '../../src/modules/fulfillment/monitoring.js';
import { monitoringOptions } from '../../src/modules/fulfillment/monitoring-options.js';
import { fulfillmentWorker } from '../../src/modules/fulfillment/worker.js';

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('fulfillment lifecycle on isolated local MySQL', () => {
  const schema = `pos_rewrite_fulfillment_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const models = [
    ExpressLineItem,
    ExpressOrderStatusLog,
    HasProduct,
    HyperlocalRejectionReason,
    Notification,
    Order,
    OrderStatus,
    PaymentStatus,
    Product,
    PosUser,
    UserStore,
    Store,
    UsersNotification,
  ];
  const user: Principal = {
    id: '900001',
    name: 'Fixture operator',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  };
  const clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'fulfillment-local-fixture-'.repeat(3),
  });
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  const bus = notificationBus(config);
  function db() {
    if (!databases) throw new Error('Fixture not initialized');
    return databases;
  }
  async function insert(model: MySqlTable, overrides: Record<string, string | number | null>) {
    const cfg = getTableConfig(model);
    const known = new Set(cfg.columns.map((column) => column.name));
    if (Object.keys(overrides).some((key) => !known.has(key)))
      throw new Error('Fixture overrides contain an unmapped column.');
    const columns = cfg.columns.filter(
      (column) =>
        !('autoIncrement' in column && column.autoIncrement && !(column.name in overrides)),
    );
    const values = columns.map((column) => {
      if (column.name in overrides) return overrides[column.name];
      if (!column.notNull) return null;
      const type = column.getSQLType().toLowerCase();
      if (type.startsWith('datetime') || type.startsWith('timestamp')) return '2026-11-16 12:00:00';
      if (type === 'date') return '2026-11-16';
      if (/^(bigint|int|smallint|tinyint|double|float|decimal|mediumint|boolean)/.test(type))
        return 0;
      return '';
    });
    await admin!.query(
      `INSERT INTO ${mysql.escapeId(cfg.name)} (${columns.map((column) => mysql.escapeId(column.name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      values,
    );
  }
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Fulfillment fixtures require a local MySQL host.');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await admin.changeUser({ database: schema });
    for (const model of models) {
      const cfg = getTableConfig(model);
      const columns = cfg.columns.map(
        (column) =>
          mysql.escapeId(column.name) +
          ' ' +
          column.getSQLType() +
          (column.notNull ? ' NOT NULL' : ' NULL') +
          ('autoIncrement' in column && column.autoIncrement ? ' AUTO_INCREMENT' : '') +
          (column.primary ? ' PRIMARY KEY' : ''),
      );
      await admin.query(
        `CREATE TABLE ${mysql.escapeId(cfg.name)} (${columns.join(',')}) ENGINE=InnoDB`,
      );
    }
    for (const query of readFileSync('src/modules/fulfillment/migration.sql', 'utf8')
      .split(';')
      .filter((value) => value.trim()))
      await admin.query(query);
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'fulfillment-mysql-local-'.repeat(3),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  beforeEach(async () => {
    for (const model of models)
      await admin!.query(`TRUNCATE TABLE ${mysql.escapeId(getTableConfig(model).name)}`);
    for (const name of [
      'pos_rewrite_fulfillment_commands',
      'pos_rewrite_fulfillment_effects',
      'pos_rewrite_notification_events',
    ])
      await admin!.query(`TRUNCATE TABLE ${mysql.escapeId(name)}`);
    await insert(Store, { id: 1, store_name: 'Fixture store', is_active: 1, type: 'STORE' });
    await insert(PosUser, { id: Number(user.id), is_active: 1, role: 4, user_type: 1 });
    await insert(UserStore, { django_user_id: Number(user.id), store_id: 1 });
    await insert(Product, { id: 101, product: 'Fixture tee' });
    await insert(Order, {
      id: 1001,
      order_ref_no: 'FIXTURE-1001',
      first_name: 'Fixture',
      created_at: '2026-11-16 10:00:00',
    });
    for (const [id, status, storeId] of [
      [501, 'PENDING', 1],
      [502, 'PENDING', 1],
      [503, 'PENDING', 2],
    ] as const) {
      await insert(HasProduct, {
        id,
        order_id: 1001,
        prod_id: 101,
        qty: 1,
        pre_gst_amt: 100,
        gst: 5,
        status: 'CONFIRMED',
        shipment_id: 'SAMPLE-SHIPMENT',
        awb: 'SAMPLE-AWB',
      });
      await insert(ExpressLineItem, {
        id: id - 400,
        order_id: 1001,
        store_id: storeId,
        has_product_id: id,
        status,
        pending_expires_at: '2026-11-16 14:00:00',
        accepted_expires_at: '2026-11-16 16:00:00',
        vinc_status: 'Allocated',
      });
    }
    await insert(HyperlocalRejectionReason, { id: 1, reason: 'Fixture reason', is_active: 1 });
  });
  it('keeps notification IDs above the safe integer boundary distinct through cursors and read updates', async () => {
    const first = '9007199254740993',
      second = '9007199254740994';
    for (const id of [first, second]) {
      await insert(Notification, {
        id,
        store_id: 1,
        order_id: 1001,
        title: 'Fixture notification',
      });
      await insert(UsersNotification, {
        notification_id: id,
        pos_admin_id: Number(user.id),
        is_viewed: 0,
      });
    }
    const service = fulfillmentService(config, db());
    const rows = await service.notifications(user, '1', first);
    expect(rows.data.map((row) => row.id)).toEqual([second]);
    expect(rows.unreadCount).toBe(2);
    await service.markNotificationRead(user, '1', second);
    const after = await service.notifications(user, '1');
    expect(after.data.find((row) => row.id === first)?.isViewed).toBe(false);
    expect(after.data.find((row) => row.id === second)?.isViewed).toBe(true);
    expect(after.unreadCount).toBe(1);
    const delivery = notificationDelivery(config, db(), bus, {
        checkedInUsers: async () => [user.id],
      }),
      created = await delivery.receive({
        eventId: crypto.randomUUID(),
        orderId: '1001',
        storeIds: ['1'],
      });
    expect(created.data[0]?.notificationId).toBe('9007199254740995');
    expect((await service.notifications(user, '1', second)).data.map((row) => row.id)).toEqual([
      '9007199254740995',
    ]);
  });
  it('uses writer-current assignment/account/role before actions, retries and administrator edits', async () => {
    const service = fulfillmentService(config, db(), clock),
      command = {
        commandId: crypto.randomUUID(),
        action: 'ACCEPT' as const,
        orderId: '1001',
        storeId: '1',
      };
    await service.execute(user, command);
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=?', [user.id]);
    await expect(service.execute(user, command)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await expect(service.receipt(user, command.commandId)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await expect(service.markNotificationRead(user, '1', '1')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    const [commands] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM pos_rewrite_fulfillment_commands',
    );
    expect(Number(commands[0]?.count)).toBe(1);
    await admin!.query('UPDATE pos_user SET role=1 WHERE id=?', [user.id]);
    const staleAdmin = { ...user, role: 1 as const };
    await service.edit(staleAdmin, '1', '1001', { status: 'PENDING' });
    await admin!.query('UPDATE pos_user SET role=4 WHERE id=?', [user.id]);
    await expect(
      service.edit(staleAdmin, '1', '1001', { status: 'ACCEPTED' }),
    ).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
    await admin!.query('UPDATE pos_user SET is_active=0 WHERE id=?', [user.id]);
    await expect(
      service.execute(user, { ...command, commandId: crypto.randomUUID(), action: 'PACK' }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(
      service.execute({ ...user, id: 'service-courier' }, command),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  afterAll(async () => {
    await bus.close();
    await databases?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });
  it('serializes concurrent retries and changes only scoped lines with one status log', async () => {
    const service = fulfillmentService(config, db(), clock),
      command = {
        commandId: crypto.randomUUID(),
        storeId: '1',
        orderId: '1001',
        action: 'ACCEPT' as const,
      };
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => service.execute(user, command)),
    );
    expect(
      receipts.every(
        (receipt) => receipt.updatedCount === 2 && receipt.commandId === command.commandId,
      ),
    ).toBe(true);
    const lines = await db().get('writer').select().from(ExpressLineItem);
    expect(
      lines.filter((line) => line.store_id === 1).every((line) => line.status === 'ACCEPTED'),
    ).toBe(true);
    expect(lines.find((line) => line.store_id === 2)?.status).toBe('PENDING');
    expect(await db().get('writer').select().from(ExpressOrderStatusLog)).toHaveLength(1);
    expect(await db().get('writer').select().from(fulfillmentEffects)).toHaveLength(2);
    await expect(service.execute(user, { ...command, action: 'PACK' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('preserves all-store distinct-status counts, split pairs, scope and packed-log timers', async () => {
    const tables: Record<string, string> = {
      EXPRESS_LINES: 'express_line_item',
      ORDERS: 'orders',
      HAS_PRODUCTS: 'has_products',
      PRODUCTS: 'products',
      STORES: 'stores',
      ORDER_STATUSES: 'order_status',
      PAYMENT_STATUSES: 'payment_status',
      STATUS_LOGS: 'express_order_status_log',
    };
    const options = monitoringOptions(
      Object.fromEntries(
        Object.entries(tables).map(([key, table]) => [
          'BQ_FULFILLMENT_' + key,
          'fixture-project.fulfillment.' + table,
        ]),
      ),
    );
    const monitor = fulfillmentMonitoring(
        config,
        db(),
        options,
        {
          async queryReport(statement, params) {
            // Execute the report's bound join projection against the disposable
            // original tables. Only dialect syntax changes; no fact/column/date
            // predicates are removed and this is never a runtime fallback.
            const values: unknown[] = [];
            let query = statement
              .replace(/`fixture-project\.fulfillment\.([a-z_]+)`/g, (_whole, table: string) =>
                mysql.escapeId(table),
              )
              .replace(/\bAS STRING\b/g, 'AS CHAR')
              .replace(/DATETIME\(@(start|end)\)/g, 'CAST(@$1 AS DATETIME)')
              .replace(
                /IN UNNEST\(@(\w+)\)|@(\w+)/g,
                (_whole, arrayName: string | undefined, name: string | undefined) => {
                  if (arrayName) {
                    const items = params[arrayName];
                    if (!Array.isArray(items) || !items.length)
                      throw new Error('Fixture requires nonempty bound IDs.');
                    values.push(...items);
                    return 'IN (' + items.map(() => '?').join(',') + ')';
                  }
                  values.push(params[name!]);
                  return '?';
                },
              );
            if (statement.startsWith('SELECT COUNT(*)')) query += ' AS fixture_count';
            const [rows] = await admin!.query<mysql.RowDataPacket[]>(query, values);
            return rows;
          },
        },
        clock,
      ),
      input = {
        from: '2026-11-16',
        to: '2026-11-16',
        tab: 'in_queue' as const,
        page: 99,
        pageSize: 10 as const,
      };
    const scoped = await monitor.read(user, input);
    expect(scoped.reader).toBe('bigquery');
    expect(scoped.tabCounts.in_queue).toBe(1);
    expect(scoped.total).toBe(1);
    expect(scoped.page).toBe(1);
    expect(scoped.data[0]?.lines).toHaveLength(2);
    expect(scoped.data[0]?.storeOrderAmount).toBe(210);
    const split = await monitor.read({ ...user, role: 1 }, { ...input, storeIds: ['1', '2'] });
    expect(split.total).toBe(2);
    expect(split.tabCounts.in_queue).toBe(1);
    expect(split.data.every((row) => row.isSplit)).toBe(true);
    await expect(monitor.read(user, { ...input, storeIds: ['2'] })).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await db()
      .get('writer')
      .update(ExpressLineItem)
      .set({ status: 'PACKED', updated_at: '2026-11-16 12:00:00' })
      .where(eq(ExpressLineItem.store_id, 1));
    await insert(ExpressOrderStatusLog, {
      order_id: 1001,
      store_id: 1,
      old_status: 'ACCEPTED',
      new_status: 'PACKED',
      changed_at: '2026-11-16 13:00:00',
    });
    const packed = await monitor.read(user, { ...input, tab: 'packed' });
    expect(packed.data[0]?.packedAt).toBe('2026-11-16 13:00:00');
    expect(packed.data[0]?.packedSeconds).toBe(1800);
  });
  it('preserves line packing, bulk shipping and received-RTO guards', async () => {
    const service = fulfillmentService(config, db(), clock);
    const run = (action: 'ACCEPT' | 'PACK' | 'PACK_LINE' | 'SHIP' | 'RTO', lineId?: string) =>
      service.execute(user, {
        commandId: crypto.randomUUID(),
        storeId: '1',
        orderId: '1001',
        action,
        ...(lineId ? { lineId } : {}),
      });
    await run('ACCEPT');
    const packed = await run('PACK_LINE', '101');
    expect(packed.updatedCount).toBe(1);
    const lineEffects = await db()
      .get('writer')
      .select()
      .from(fulfillmentEffects)
      .where(eq(fulfillmentEffects.commandId, packed.commandId));
    expect(lineEffects.map((row) => row.kind)).toEqual(['concurrency-sync']);
    await run('PACK');
    const shipped = await run('SHIP');
    expect(shipped.updatedCount).toBe(2);
    const [order] = await db().get('writer').select().from(Order);
    expect(order?.order_statuses).toBe(26n);
    expect(
      (await db().get('writer').select().from(HasProduct).where(eq(HasProduct.id, 501n)))[0]
        ?.status,
    ).toBe('OUT_FOR_DELIVERY');
    await expect(run('RTO')).rejects.toMatchObject({ code: 'RTO_NOT_RECEIVED' });
    await db()
      .get('writer')
      .update(HasProduct)
      .set({ status: 'RTO_DELIVERED' })
      .where(eq(HasProduct.order, 1001n));
    expect((await run('RTO')).updatedCount).toBe(2);
  });
  it('does not retry a counter delta after an uncertain remote result', async () => {
    const receipt = await fulfillmentService(config, db(), clock).execute(user, {
      commandId: crypto.randomUUID(),
      storeId: '1',
      orderId: '1001',
      action: 'ACCEPT',
    });
    const deliveries: EffectDelivery[] = [];
    const outbox = fulfillmentOutbox(
      config,
      db(),
      async (delivery) => {
        deliveries.push(delivery);
        throw new Error('simulated response lost');
      },
      clock,
    );
    expect(await outbox.dispatchNext()).toMatchObject({ status: 'UNCERTAIN' });
    expect(await outbox.dispatchNext()).toBeNull();
    const rows = await db().get('writer').select().from(fulfillmentEffects);
    expect(deliveries).toHaveLength(1);
    expect(rows.find((row) => row.id === receipt.effectIds[0])?.attempts).toBe(1);
    expect(rows.find((row) => row.id === receipt.effectIds[1])?.status).toBe('PENDING');
  });
  it('serializes counter deltas by store even when multiple workers claim independent commands', async () => {
    const service = fulfillmentService(config, db(), clock);
    await service.execute(user, {
      commandId: crypto.randomUUID(),
      storeId: '1',
      orderId: '1001',
      action: 'ACCEPT',
    });
    await service.execute(user, {
      commandId: crypto.randomUUID(),
      storeId: '1',
      orderId: '1001',
      action: 'PACK',
    });
    const delivered: EffectDelivery[] = [],
      firstStarted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const outbox = fulfillmentOutbox(
      config,
      db(),
      async (effect) => {
        delivered.push(effect);
        if (effect.kind === 'concurrency-sync' && effect.payload.accepted === 2) {
          firstStarted.resolve();
          await release.promise;
        }
      },
      clock,
    );
    const first = outbox.dispatchNext();
    await firstStarted.promise;
    await outbox.dispatchNext();
    await outbox.dispatchNext();
    expect(
      delivered
        .filter((effect) => effect.kind === 'concurrency-sync')
        .map((effect) => effect.payload.accepted),
    ).toEqual([2]);
    release.resolve();
    await first;
    for (let index = 0; index < 8; index++) if (!(await outbox.dispatchNext())) break;
    expect(
      delivered
        .filter((effect) => effect.kind === 'concurrency-sync')
        .map((effect) => effect.payload.accepted),
    ).toEqual([2, -2]);
  });
  it('runs and drains the delivery worker with originating request/user IDs and no payload logging', async () => {
    await db().get('writer').update(ExpressLineItem).set({
      pending_expires_at: '2099-01-01 12:00:00',
      accepted_expires_at: '2099-01-01 14:00:00',
    });
    const requestId = crypto.randomUUID(),
      command = {
        commandId: crypto.randomUUID(),
        storeId: '1',
        orderId: '1001',
        action: 'ACCEPT' as const,
      },
      service = fulfillmentService(config, db(), clock);
    await service.execute(user, command, requestId);
    await service.execute(user, command, crypto.randomUUID());
    const logs: Record<string, unknown>[] = [],
      options = readFulfillmentOptions({
        FULFILLMENT_WORKER_BATCH_SIZE: '4',
        FULFILLMENT_WORKER_CONCURRENCY: '2',
      }),
      outbox = fulfillmentOutbox(config, db(), async () => ({ acknowledged: true }), clock),
      maintenance = fulfillmentMaintenance(config, db(), options, clock),
      notifications = notificationDelivery(config, db(), bus, { checkedInUsers: async () => [] });
    const worker = fulfillmentWorker(
      config,
      db(),
      outbox,
      maintenance,
      notifications,
      options,
      (_level, event) => logs.push({ ...event }),
    );
    await worker.runOnce();
    await worker.runOnce();
    await worker.stop();
    const deliveries = logs.filter((event) => event.effectId);
    expect(deliveries).toHaveLength(2);
    expect(
      deliveries.every(
        (event) =>
          event.requestId === requestId &&
          event.userId === user.id &&
          typeof event.eventInstanceId === 'string',
      ),
    ).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(
      /Fixture|fixture@example|SAMPLE-AWB|payload|hasProductIds/,
    );
    const count = logs.length;
    await worker.runOnce();
    expect(logs).toHaveLength(count);
  });
  it('deduplicates webhook notices and keeps failed publications durable', async () => {
    const delivery = notificationDelivery(config, db(), bus, {
      checkedInUsers: async () => ['900001'],
    });
    const command = { eventId: crypto.randomUUID(), orderId: '1001', storeIds: ['1', '1'] };
    const result = await Promise.all(Array.from({ length: 4 }, () => delivery.receive(command)));
    expect(new Set(result.map((row) => row.data[0]?.notificationId)).size).toBe(1);
    expect(result.every((row) => row.data[0]?.publication === 'pending')).toBe(true);
    expect(await db().get('writer').select().from(Notification)).toHaveLength(1);
    expect(await db().get('writer').select().from(UsersNotification)).toHaveLength(1);
    expect(await db().get('writer').select().from(fulfillmentEffects)).toHaveLength(1);
    await expect(delivery.receive({ ...command, orderId: '1002' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('auto-packs only expired accepted lines with one counter delta, then supports idempotent courier shipment', async () => {
    const service = fulfillmentService(config, db(), clock);
    await service.execute(user, {
      commandId: crypto.randomUUID(),
      storeId: '1',
      orderId: '1001',
      action: 'ACCEPT',
    });
    await db()
      .get('writer')
      .update(ExpressLineItem)
      .set({ accepted_expires_at: '2026-11-16 12:00:00' })
      .where(eq(ExpressLineItem.store_id, 1));
    const maintenance = fulfillmentMaintenance(config, db(), readFulfillmentOptions({}), clock);
    expect(await maintenance.runStore('1')).toMatchObject({ packed: 2, rejected: 0, timedOut: 0 });
    const effects = await db().get('writer').select().from(fulfillmentEffects);
    expect(
      effects
        .filter((effect) => effect.operatorId === 'service' && effect.kind === 'concurrency-sync')
        .map((effect) => effect.payload.accepted),
    ).toEqual([-2]);
    expect(
      (await db().get('writer').select().from(HasProduct).where(eq(HasProduct.id, 501n)))[0]
        ?.status,
    ).toBe('CONFIRMED');
    const commandId = crypto.randomUUID(),
      receipt = await service.shipFromCourier(commandId, '1001', 'SAMPLE-AWB');
    expect(receipt.updatedCount).toBe(2);
    expect(await service.shipFromCourier(commandId, '1001', 'SAMPLE-AWB')).toEqual(receipt);
    await expect(service.shipFromCourier(commandId, '1001', 'DIFFERENT-AWB')).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  });
  it('runs expiry transitions transactionally once and retries delayed allocations', async () => {
    await db()
      .get('writer')
      .update(ExpressLineItem)
      .set({ pending_expires_at: '2026-11-16 12:00:00', vinc_status: '' })
      .where(eq(ExpressLineItem.id, 102));
    await db()
      .get('writer')
      .update(ExpressLineItem)
      .set({ pending_expires_at: '2026-11-16 12:00:00' })
      .where(eq(ExpressLineItem.id, 101));
    const maintenance = fulfillmentMaintenance(config, db(), readFulfillmentOptions({}), clock);
    const results = await Promise.all([maintenance.runStore('1'), maintenance.runStore('1')]);
    expect(results.reduce((sum, result) => sum + result.timedOut, 0)).toBe(2);
    expect(await db().get('writer').select().from(ExpressOrderStatusLog)).toHaveLength(1);
    await db()
      .get('writer')
      .update(ExpressLineItem)
      .set({ vinc_status: 'Part Allocated' })
      .where(eq(ExpressLineItem.id, 102));
    expect(await maintenance.runStore('1')).toMatchObject({ rejected: 2, timedOut: 0, packed: 0 });
    const rows = await db().get('writer').select().from(ExpressLineItem);
    expect(
      rows
        .filter((row) => row.store_id === 1)
        .every((row) => row.status === 'REJECTED' && row.rejection_reason_id === 5),
    ).toBe(true);
    expect(rows.find((row) => row.store_id === 2)?.status).toBe('PENDING');
    expect(await db().get('writer').select().from(ExpressOrderStatusLog)).toHaveLength(2);
  });
});
