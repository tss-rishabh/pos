import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { splitMigration } from '../../src/db/migrations.js';
import {
  availableStockProjection,
  availableSystemStockProjection,
} from '../../src/db/stock-projection/service.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { identifier } from '../../src/domain/validation.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { lifecycleRuntime } from '../../src/modules/legacy-fulfillment/lifecycle/runtime.js';
import { localDeliveryService } from '../../src/modules/legacy-fulfillment/lifecycle/service.js';
import { localDeliveryWorker } from '../../src/modules/legacy-fulfillment/lifecycle/worker.js';
import { readLegacyLifecycleOptions } from '../../src/modules/legacy-fulfillment/lifecycle/options.js';
import type {
  ProviderKind,
  ProviderObservation,
  ProviderRequest,
  ProviderResult,
} from '../../src/modules/legacy-fulfillment/lifecycle/contracts.js';
import type { LegacyProvider } from '../../src/modules/legacy-fulfillment/lifecycle/provider.js';
import { providerRequestHash } from '../../src/modules/legacy-fulfillment/lifecycle/domain.js';

const physical = [
  'stores',
  'orders',
  'products',
  'product_store',
  'pos_user',
  'user_stores',
  'express_line_item',
  'hyperlocal_order_log',
  'hyperlocal_fd_logs',
  'has_products',
  'pos_transaction_logs',
  'product_stocks',
  'product_inventory_logs',
  'pos_inventory_sync_log',
  'products_inventory_logs',
  'pos_product_inventory_logs',
  'attributes',
  'has_options',
  'hold_stock_store',
  'pos_hold_stock_logs',
  'pos_hyperlocal_slots',
  'tss_settings',
  'order_addons',
  'users',
  'tss_money_history',
  'hyperlocal_to_online_order_logs',
  'pos_notifications',
  'pos_user_notifications',
  'cancel_orders',
];
export const deliveryOrderId = '9007199254740993',
  deliveryHpIds = ['9007199254741993', '9007199254741994', '9007199254741995'],
  deliveryUser: Principal = {
    id: '44',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1', '2', '3'],
  };
export async function createLifecycleFixture() {
  const configured = process.env.MYSQL_INTEGRATION_URL;
  if (!configured) throw new Error('Guarded lifecycle fixture URL required.');
  const url = new URL(configured);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_integration'
  )
    throw new Error('Lifecycle fixtures require guarded localhost integration.');
  const schema =
      'pos_rewrite_delivery_lifecycle_test_' + randomUUID().replaceAll('-', '').slice(0, 12),
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
  await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
  await connection.changeUser({ database: schema });
  const fixture = verifiedMysqlFixture(connection, [
    'evidence/mysql-legacy-fulfillment-schema.json',
    'evidence/mysql-legacy-cancellations-schema.json',
  ]);
  await fixture.create(physical);
  const owned = [
    'pos_rewrite_operator_checkins',
    'pos_rewrite_administration_outbox',
    'pos_rewrite_legacy_fulfillment_commands',
    'pos_rewrite_legacy_rto_receipts',
    'pos_rewrite_local_delivery_orders',
    'pos_rewrite_local_delivery_commands',
    'pos_rewrite_local_delivery_calls',
    'pos_rewrite_local_delivery_jobs',
    'pos_rewrite_notification_events',
  ];
  for (const filename of [
    'src/modules/administration/migration.sql',
    'src/modules/fulfillment/migration.sql',
    'src/modules/fulfillment/trace-migration.sql',
    'src/modules/legacy-fulfillment/migration.sql',
    'src/modules/legacy-fulfillment/lifecycle/migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(filename, 'utf8')))
      await connection.query(statement);
  url.pathname = '/' + schema;
  const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'delivery-lifecycle-fixture-'.repeat(4),
    }),
    database = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'delivery-local-'.repeat(5),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  let now = Temporal.Instant.from('2026-11-16T08:00:00Z'),
    lostKind: ProviderKind | null = null,
    rejectCourier = false;
  const sends: ProviderRequest[] = [],
    remote = new Map<string, ProviderResult>(),
    unavailable = new Set<ProviderKind>(),
    clock = () => now;
  const ids = z.array(
    z.object({
      id: identifier,
      productId: identifier,
      quantity: z.coerce.number().int(),
      platform: z.string(),
      status: z.string(),
    }),
  );
  async function lines(orderId: string, productId?: string) {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT CAST(id AS CHAR) id,CAST(prod_id AS CHAR) productId,qty quantity,CAST(order_platform_id AS CHAR) platform,status FROM has_products WHERE order_id=?' +
        (productId ? ' AND prod_id=?' : '') +
        ' ORDER BY id',
      productId ? [orderId, productId] : [orderId],
    );
    return ids.parse(rows);
  }
  const gateway: LegacyProvider = {
    ready: (kind) => !unavailable.has(kind),
    async send(request) {
      sends.push(request);
      let result: ProviderResult;
      if (request.kind === 'borzo-create')
        result = rejectCourier
          ? { kind: 'rejected', noSideEffects: true }
          : {
              kind: 'courier-created',
              courierOrderId: '9007199254742999',
              sourceTracking: 'https://tracking.example.test/source',
              destinationTracking: 'https://tracking.example.test/destination',
            };
      else if (request.kind === 'online-convert') {
        const child = '9007199254743999';
        await fixture.insert('orders', {
          id: child,
          user_id: 7,
          hl_parent_order_id: request.orderId,
          payment_status: 4,
          order_status: 1,
          location_type: 'NW',
          location_id: 0,
        });
        const selected = (await lines(request.orderId)).filter(
          (line) => !request.split || line.platform === '4',
        );
        for (const [index, line] of selected.entries())
          await fixture.insert('has_products', {
            id: String(9007199254750000n + BigInt(index)),
            order_id: child,
            prod_id: line.productId,
            sub_prod_id: 0,
            qty: line.quantity,
            order_platform_id: 1,
            status: 'PLACED',
          });
        result = { kind: 'online-created', newOrderId: child, hlCharges: request.split ? 0 : 50 };
      } else if (request.kind === 'cancel-order' || request.kind === 'cancel-item') {
        const selected = await lines(
          request.orderId,
          request.kind === 'cancel-item' ? request.productId || undefined : undefined,
        );
        for (const line of selected) {
          await fixture.insert('cancel_orders', {
            order_status: 4,
            order_id: request.orderId,
            prod_id: line.productId,
            sub_prod_id: 0,
            qty: line.quantity,
            received: 0,
            reason_id: 0,
            other_reason: '',
            comment: request.reason,
            has_product_id: null,
          });
          await connection.query("UPDATE has_products SET status='CANCELLED' WHERE id=?", [
            line.id,
          ]);
        }
        if (request.kind === 'cancel-order')
          await connection.query('UPDATE hyperlocal_order_log SET is_refunded=1 WHERE order_id=?', [
            request.orderId,
          ]);
        const remaining = (await lines(request.orderId)).some(
          (line) => line.status !== 'CANCELLED',
        );
        if (!remaining)
          await connection.query('UPDATE orders SET order_status=4 WHERE id=?', [request.orderId]);
        result = { kind: 'acknowledged' };
      } else if (request.kind === 'split-charge-refund') {
        const relevant = (await lines(request.orderId)).filter((line) =>
          ['3', '4'].includes(line.platform),
        );
        if (
          relevant.length &&
          relevant.every((line) =>
            [
              'DELIVERY_EXCEPTION',
              'RTO_INITIATED',
              'RTO_IN_TRANSIT',
              'RTO_DELIVERED',
              'UNDELIVERED',
              'CANCELLED',
            ].includes(line.status),
          )
        ) {
          await connection.query('UPDATE order_addons SET hl_charges_refunded=1 WHERE order_id=?', [
            request.orderId,
          ]);
          await fixture.insert('tss_money_history', {
            user_id: 7,
            order_id: request.orderId,
            platform: 'ORDER_REFUND',
            comment: 'Fast Delivery Charges Refunded',
            added_amt: 50,
            used_amt: 0,
            amt_before_update: 10.125,
            amt_after_update: 60.12,
          });
          await connection.query(
            'UPDATE users SET cashback=tss_money+50,tss_money=tss_money+50 WHERE id=7',
          );
        }
        result = { kind: 'acknowledged' };
      } else result = { kind: 'acknowledged' };
      remote.set(request.id, result);
      if (lostKind === request.kind) {
        lostKind = null;
        throw new AppError(502, 'PROVIDER_OUTCOME_UNKNOWN', 'Fixture lost response.');
      }
      return result;
    },
    async reconcile(request): Promise<ProviderObservation> {
      const result = remote.get(request.id);
      return result
        ? { status: 'completed', requestHash: providerRequestHash(request), result }
        : { status: 'unknown' };
    },
  };
  function build(extra: Partial<Parameters<typeof lifecycleRuntime>[3]> = {}) {
    const options = readLegacyLifecycleOptions({
        LEGACY_DELIVERY_MOVEMENT_CONTRACT: 'pos-local-delivery-movement-v1',
        LEGACY_DELIVERY_WORKER_ENABLED: 'true',
        HYPERLOCAL_CUT_OFF_SWITCH: 'false',
        BAMBOO_TOOTHBRUSH_EM: '999',
        WELCOME_NOTE_PRODUCT_ID: '998',
      }),
      runtime = lifecycleRuntime(config, database, options, {
        stockProcedure: availableStockProjection(config.BUSINESS_TIMEZONE, clock),
        systemStockProcedure: availableSystemStockProjection(config.BUSINESS_TIMEZONE, clock),
        synchronizationAvailable: true,
        clock,
        ...extra,
        provider: extra.provider || gateway,
      }),
      service = localDeliveryService(runtime),
      worker = localDeliveryWorker(runtime, service, {
        hs256: 'fixture-key-'.repeat(5),
        hs512: 'fixture-key-512-'.repeat(5),
      });
    return { runtime, service, worker };
  }
  async function reset() {
    for (const table of [
      ...physical,
      ...owned,
      'pos_rewrite_fulfillment_effects',
      'pos_rewrite_fulfillment_commands',
    ])
      await connection.query(`DELETE FROM ${mysql.escapeId(table)}`);
    // Restore verified production shape after a preceding isolated compatibility-correction case.
    await connection.query(
      'ALTER TABLE hyperlocal_order_log MODIFY delivery_exception_date DATETIME NOT NULL',
    );
    sends.length = 0;
    remote.clear();
    unavailable.clear();
    lostKind = null;
    rejectCourier = false;
    now = Temporal.Instant.from('2026-11-16T08:00:00Z');
    for (const id of [1, 2, 3])
      await fixture.insert('stores', {
        id,
        store_name: 'Fixture store ' + id,
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
        location_code: 'FIXTURE' + id,
        ecom_delivery: 1,
        ecom_threshold: 0,
      });
    await fixture.insert('pos_user', {
      id: 44,
      role: 4,
      user_type: 1,
      is_active: 1,
      first_name: 'Fixture',
      last_name: 'Manager',
    });
    for (const id of [1, 2, 3])
      await fixture.insert('user_stores', { id, django_user_id: 44, store_id: id });
    await connection.query(
      "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,checked_in_at,expires_at)VALUES('44',1,NULL,'2026-11-16 00:00:00','2099-01-01 00:00:00')",
    );
    await fixture.insert('users', {
      id: 7,
      status: 1,
      is_block: 0,
      is_two_fa: 0,
      tss_money: 10.125,
      cashback: 10.125,
      firstname: 'Fixture',
      lastname: 'Customer',
      email: 'fixture@example.test',
      telephone: '0000000000',
    });
    await fixture.insert('orders', {
      id: deliveryOrderId,
      user_id: 7,
      location_type: 'SW',
      location_id: 1,
      next_location_ids: '[2,3]',
      is_transfer: 0,
      is_split_order: 1,
      order_status: 1,
      payment_status: 4,
      hl_charges: 50,
      start_timeslot: '2026-11-16 10:00:00',
      end_timeslot: '2026-11-16 12:00:00',
    });
    await fixture.insert('order_addons', {
      id: 1,
      order_id: deliveryOrderId,
      hl_charges_refunded: 0,
    });
    await fixture.insert('hyperlocal_order_log', {
      id: 1,
      order_id: deliveryOrderId,
      action: 'NO_ACTION',
      main_location_id: 1,
      is_created_in_borzo: 0,
      borzo_id: 0,
      is_pack: 0,
      is_rto: 0,
      rto_recieved: 0,
      is_refunded: 0,
    });
    for (const productId of [10, 11]) {
      await fixture.insert('products', {
        id: productId,
        prod_type: 1,
        parent_prod_id: 0,
        product: 'Fixture product ' + productId,
      });
      await fixture.insert('product_stocks', {
        prod_id: productId,
        parent_prod_id: 0,
        stock: 15,
        stocked: 0,
      });
      for (const storeId of [1, 2, 3])
        await fixture.insert('product_store', {
          id: productId + storeId * 100,
          product_id: productId,
          store_id: storeId,
          stock: 5,
          is_avail: 1,
          is_del: 0,
        });
    }
    for (const [index, product, quantity, platform] of [
      [0, 10, 2, 4],
      [1, 10, 1, 4],
      [2, 11, 4, 1],
    ] as const)
      await fixture.insert('has_products', {
        id: deliveryHpIds[index]!,
        order_id: deliveryOrderId,
        prod_id: product,
        sub_prod_id: 0,
        qty: quantity,
        order_platform_id: platform,
        status: 'PLACED',
      });
    await fixture.insert('tss_settings', {
      id: 1,
      platform: 'ORDER_CREATION_BUFFER_TIME_IN_SEC',
      value: '3600',
    });
    await fixture.insert('pos_hyperlocal_slots', {
      id: 1,
      store_id: 1,
      weekday: 'MON',
      is_avail: 1,
      start_timeslot: '10:00:00',
      end_timeslot: '17:00:00',
      pos_admin_id: 0,
    });
  }
  return {
    connection,
    fixture,
    async applyInitialLogCompatibility() {
      const statement = readFileSync(
        'src/modules/legacy-fulfillment/lifecycle/compatibility/001_unset_exception_date.sql',
        'utf8',
      )
        .replace(/^--.*$/gm, '')
        .trim();
      if (
        !/^ALTER TABLE hyperlocal_order_log\s+MODIFY COLUMN delivery_exception_date DATETIME NULL DEFAULT NULL;$/.test(
          statement,
        )
      )
        throw new Error('UNEXPECTED_LOCAL_COMPATIBILITY_STATEMENT');
      // Only this guarded randomized localhost fixture may execute the review candidate.
      // The shared migration runner intentionally rejects all source-table ALTER statements.
      await connection.query(statement);
    },
    database,
    config,
    clock,
    sends,
    remote,
    unavailable,
    build,
    reset,
    lines,
    setNow: (value: string) => {
      now = Temporal.Instant.from(value);
    },
    loseNext: (kind: ProviderKind) => {
      lostKind = kind;
    },
    rejectCourier: () => {
      rejectCourier = true;
    },
    checkin: async (storeId: string) => {
      await connection.query(
        "UPDATE pos_rewrite_operator_checkins SET store_id=? WHERE operator_id='44'",
        [storeId],
      );
    },
    async count(table: string) {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) total FROM ${mysql.escapeId(table)}`,
      );
      return z.array(z.object({ total: z.coerce.number().int() })).parse(rows)[0]!.total;
    },
    async close() {
      await database.close();
      await connection.changeUser({ database: 'mysql' });
      await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    },
  };
}
export type LifecycleFixture = Awaited<ReturnType<typeof createLifecycleFixture>>;
