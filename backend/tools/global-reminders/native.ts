/** Real application/services/native rows. All identities and commands are synthetic. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mock } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { identityService } from '../../src/auth/identity.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { migrationPaths, splitMigration } from '../../src/db/migrations.js';
import { barcodeFixture } from '../administration/barcodes/fixture.js';

export const fixtureNow = Date.parse('2026-11-18T12:00:00Z');
export const fixtureDay = '2026-11-18';
export const expirySchema = z.object({
  expiringSoon: z.array(
    z.object({ orderId: z.string(), type: z.enum(['pending', 'accepted']), expiresAt: z.string() }),
  ),
  bannerCounts: z.object({ unaccepted: z.number(), unpacked: z.number(), packed: z.number() }),
  pollIntervalMs: z.number(),
  businessTimeZone: z.string(),
});
const sourceExpiry = z.object({
  expiring_soon: z.array(
    z.object({
      order_id: z.number(),
      type: z.enum(['pending', 'accepted']),
      expires_at: z.string(),
    }),
  ),
  banner_counts: z.object({ unaccepted: z.number(), unpacked: z.number(), packed: z.number() }),
});

export async function remindersFixture(connection: string, origin: string, source: string) {
  const url = new URL(connection);
  assert(
    url.protocol === 'mysql:' &&
      url.hostname === '127.0.0.1' &&
      url.port &&
      url.port !== '54777' &&
      url.pathname === '/pos_rewrite_global_reminders' &&
      !url.search &&
      !url.hash,
    'Owned localhost reminder fixture required',
  );
  assert(new URL(origin).hostname === '127.0.0.1');
  // Explicit test-only clock seam. Timers/network/database are not mocked.
  mock.timers.enable({ apis: ['Date'], now: fixtureNow });
  const native = await barcodeFixture(connection);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let identity: ReturnType<typeof identityService> | undefined;
  try {
    await native.fixture.create([
      'user_stores',
      'pos_franchise',
      'tss_settings',
      'store_counters',
      'orders',
      'order_stores',
      'has_products',
      'users',
      'express_line_item',
      'store_day_close',
      'store_day_banking',
      'store_cash_opening_balance',
      'amount_to_be_refunded_log',
      'return_orders',
      'pos_notifications',
      'pos_user_notifications',
      'hyperlocal_rejection_reasons',
    ]);
    const alreadyApplied = new Set([
      'src/modules/catalog-details/maintenance-migration.sql',
      'src/modules/administration/barcodes/migration.sql',
    ]);
    for (const filename of migrationPaths) {
      if (alreadyApplied.has(filename)) continue;
      for (const statement of splitMigration(readFileSync(filename, 'utf8')))
        await native.admin.query(statement);
    }
    for (const id of ['1', '2']) {
      await native.seed('stores', {
        id,
        store_name: `Reminder store ${id}`,
        short_name: `RM${id}`,
        location_code: `RM${id}`,
        phone: `900000000${id}`,
        category: 'IN_HOUSE',
        type: 'STORE',
        is_active: 1,
        latitude: '19.0760000000000000',
        longitude: '72.8777000000000000',
        city_id: 0,
        country_id: 0,
        state_id: 0,
        per_day_threshold: 0,
        per_hour_threshold: 0,
        store_image: 'uploads/stores/stores_image/default_store_image.jpeg',
      });
      await native.seed('store_counters', {
        id,
        store_id: id,
        counter_name: `RM${id}`,
        is_active: 1,
      });
    }
    for (const [id, role] of [
      ['1', 1],
      ['2', 4],
    ] as const) {
      await native.seed('pos_user', {
        id,
        username: `reminder-${id}`,
        first_name: 'Synthetic',
        last_name: 'Operator',
        role,
        user_type: 1,
        is_active: 1,
        is_staff: 1,
        otp_method: 2,
      });
      for (const store of ['1', '2'])
        await native.seed('user_stores', { django_user_id: id, store_id: store });
    }
    await native.seed('users', { id: '777', firstname: 'Synthetic', lastname: 'Guest', status: 1 });
    await native.seed('products', {
      id: '100',
      product: 'Reminder fixture item',
      parent_prod_id: 0,
      prod_type: 1,
    });
    for (const id of ['101', '102', '103']) {
      await native.seed('orders', {
        id,
        user_id: '777',
        order_amt: '100.00',
        pay_amt: '100.00',
        created_at: '2026-11-18 15:00:00',
      });
      await native.seed('order_stores', {
        id,
        order_id: id,
        store_id: '1',
        counter_id: '1',
        admin_user_id: '1',
        offline_payment: '0.00',
        online_payment: '0.00',
        online_other_payment: '0.00',
      });
      await native.seed('has_products', {
        id,
        order_id: id,
        prod_id: '100',
        qty: '1',
        status: 'PLACED',
        pre_gst_amt: 100,
        gst: 5,
      });
    }
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      WEB_ORIGIN: origin,
      SESSION_SECRET: 'synthetic-reminder-native-session-'.repeat(3),
      MYSQL_WRITER_URL: native.url,
      MYSQL_PRIMARY_READER_URL: native.url,
      MYSQL_DATA_READER_URL: native.url,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
      DAY_CLOSE_ENABLED_STORE_IDS: 'all',
      DAY_CLOSE_OPEN_TIME: '00:00',
      DAY_CLOSE_CUTOFF_TIME: '23:59',
      DAY_CLOSE_NAG_EVENING_START: '00:00',
      DAY_CLOSE_NAG_MORNING_START: '00:00',
      DAY_CLOSE_NAG_INTERVAL_MINUTES: '1',
    });
    identity = identityService(config, native.db);
    const sessions = mysqlSessions(native.db),
      checkins = checkInService(native.db, config);
    async function account(id: string) {
      const user = await identity!.get(id);
      assert(user);
      const credentials = await sessions.create(id, fixtureNow + 7200000);
      await checkins.set(user, '1', '1');
      return {
        cookie: {
          name: 'pos_session',
          value: seal({ id, ...credentials }, config.SESSION_SECRET),
          url: origin,
          httpOnly: true,
          sameSite: 'Lax' as const,
        },
        user,
      };
    }
    const accounts = [await account('1'), await account('2')];
    const removedAssignments = new Map<string, string>();
    const wall = (minutes: number) =>
      Temporal.Instant.fromEpochMilliseconds(fixtureNow)
        .add({ minutes })
        .toZonedDateTimeISO('Asia/Kolkata')
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
    async function expiry(minutes: number | null) {
      await native.admin.query('DELETE FROM express_line_item');
      if (minutes === null) return;
      for (const [id, status] of [
        ['101', 'PENDING'],
        ['102', 'ACCEPTED'],
        ['103', 'PACKED'],
      ] as const)
        await native.seed('express_line_item', {
          id,
          order_id: id,
          has_product_id: id,
          store_id: '1',
          status,
          pending_expires_at: wall(minutes),
          accepted_expires_at: wall(minutes),
          created_at: wall(-60),
          vinc_status: '',
        });
    }
    async function dayClose(status: 'CLOSED' | 'STALE' | null) {
      await native.admin.query('DELETE FROM store_day_close');
      if (status)
        await native.seed('store_day_close', {
          id: '1',
          store_id: '1',
          close_date: fixtureDay,
          status,
          version: 1,
        });
    }
    await expiry(20);
    await dayClose('CLOSED');
    app = await buildApp(config, { logger: false });
    const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      apiOrigin,
      accounts,
      account,
      expiry,
      dayClose,
      async sourceExpiry() {
        const python = process.env.GLOBAL_REMINDERS_ORACLE_PYTHON;
        assert(python);
        const result = spawnSync(python, ['-B', 'tools/global-reminders/source-expiry.py'], {
          input: JSON.stringify({
            source,
            database: native.url,
            now: new Date(fixtureNow).toISOString(),
          }),
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, 'Pinned source expiry dispatch failed');
        const value = z
          .object({
            sourceCommit: z.string(),
            hashes: z.record(z.string(), z.string()),
            routeId: z.literal('order/urls.py:107'),
            body: sourceExpiry,
          })
          .parse(JSON.parse(result.stdout) as unknown);
        return value;
      },
      async checkIn(id: string, store: string) {
        const user = await identity!.get(id);
        assert(user);
        await checkins.set(user, store, store);
      },
      async archive(id: string) {
        await native.admin.query('UPDATE pos_user SET is_active=0 WHERE id=?', [id]);
      },
      async assignment(id: string, storeId: string, allowed: boolean) {
        const key = JSON.stringify([id, storeId]);
        if (allowed) {
          const previous = removedAssignments.get(key);
          assert(previous);
          await native.seed('user_stores', { id: previous, django_user_id: id, store_id: storeId });
          return;
        }
        const [rows] = await native.admin.query(
          'SELECT id FROM user_stores WHERE django_user_id=? AND store_id=?',
          [id, storeId],
        );
        const row = z
          .array(z.object({ id: z.union([z.string(), z.number().int()]).transform(String) }))
          .length(1)
          .parse(rows)[0]!;
        removedAssignments.set(key, row.id);
        await native.admin.query('DELETE FROM user_stores WHERE id=?', [row.id]);
      },
      async close() {
        await app?.close();
        await identity?.close();
        await native.close();
        mock.timers.reset();
      },
    };
  } catch (error) {
    await app?.close();
    await identity?.close();
    await native.close();
    mock.timers.reset();
    throw error;
  }
}
