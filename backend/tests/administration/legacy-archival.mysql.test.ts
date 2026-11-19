import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appStack, appStackMysqlUrl } from '../helpers/app-stack.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

/**
 * Store and operator archival (legacy `stores/urls.py:15-16`, `users/urls.py:19-20`):
 * the pinned DeleteStoreView/ActivateStoreView/DeleteUserView/ActivateUserView, their
 * permission decorators and URL wrappers, executed with real Django sessions and CSRF
 * POSTs over this disposable app-stack schema, replayed from
 * `tests/golden/administration/archival-workflow.json`. Each source case is then bound to
 * the rewrite's PATCH status route on the same rows.
 */
const original = z.object({
  sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
  routeIds: z.array(z.string()).length(4),
  hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  cases: z
    .array(
      z.object({
        resource: z.enum(['stores', 'users']),
        actorRole: z.number().nullable(),
        targetRole: z.number(),
        self: z.boolean(),
        action: z.enum(['delete', 'activate']),
        httpStatus: z.number(),
        sourceStatus: z.string().nullable(),
        permissionDenied: z.boolean(),
        failureCategory: z.string().nullable(),
        initialActive: z.boolean(),
        active: z.boolean(),
        retainedId: z.boolean(),
      }),
    )
    .length(12),
});

describe.skipIf(!appStackMysqlUrl)('pinned store/operator archival on native MySQL', () => {
  let stack: Awaited<ReturnType<typeof appStack>>;
  beforeAll(async () => {
    stack = await appStack({
      seed: async (insert) => {
        for (const [id, role, userType] of [
          ['1', 1, 1],
          ['2', 2, 1],
          ['3', 3, 1],
          ['4', 4, 1],
          ['5', 5, 1],
          ['11', 1, 2],
          ['30', 4, 1],
        ] as const) {
          await insert('pos_user', {
            id,
            username: `archival-${id}`,
            password: 'pbkdf2_sha256$600000$fixture$fixture',
            first_name: `Archival ${id}`,
            last_name: 'Fixture',
            email: `archival-${id}@example.test`,
            role,
            user_type: userType,
            is_active: 1,
            is_staff: 1,
          });
          for (const store of ['1', '2'])
            await insert('user_stores', { django_user_id: id, store_id: store });
        }
        await insert('store_counters', {
          id: '2',
          store_id: '2',
          counter_name: 'ARC2',
          is_active: 1,
        });
        await insert('orders', {
          id: '70001',
          user_id: '777',
          order_amt: '25.49',
          pay_amt: '25.49',
        });
        await insert('order_stores', {
          id: '70001',
          order_id: '70001',
          store_id: '2',
          counter_id: '2',
          admin_user_id: '30',
          offline_payment: '25.49',
          offline_payment_recieved: '25.49',
          order_invoice: 'SYNTHETIC-ARCHIVAL-RETAINED',
        });
      },
    });
    // Complete legacy Store form values for store 2 (as the original archival fixture seeded),
    // so the pinned Store.save() round-trips the row.
    await stack.admin.query(
      `UPDATE stores SET short_name='ARC2', latitude='19.0760000000000000',
        longitude='72.8777000000000000', city_id=0, country_id=0, state_id=0,
        per_day_threshold=0, per_hour_threshold=0,
        store_image='uploads/stores/stores_image/default_store_image.jpeg',
        url_key='https://thesouledstore.com/?store_id=2' WHERE id=2`,
    );
  }, 120000);
  afterAll(async () => {
    await stack?.close();
  });
  async function history() {
    const [orders] = await stack.admin.query('SELECT * FROM orders WHERE id=70001');
    const [receipts] = await stack.admin.query('SELECT * FROM order_stores WHERE id=70001');
    const [assignments] = await stack.admin.query('SELECT * FROM user_stores ORDER BY id');
    return JSON.stringify({ orders, receipts, assignments });
  }
  async function active(table: 'stores' | 'pos_user', id: string) {
    const [rows] = await stack.admin.query('SELECT is_active FROM `' + table + '` WHERE id=?', [
      id,
    ]);
    return Boolean(
      z
        .array(z.object({ is_active: z.union([z.number(), z.boolean()]) }))
        .length(1)
        .parse(rows)[0]!.is_active,
    );
  }
  async function setActive(table: 'stores' | 'pos_user', id: string, value: boolean) {
    await stack.admin.query('UPDATE `' + table + '` SET is_active=? WHERE id=?', [value, id]);
  }
  it('binds the twelve pinned archival dispatch outcomes to the rewrite status routes', async () => {
    const before = await history();
    const url = stack.config.MYSQL_WRITER_URL;
    const source = original.parse(
      JSON.parse(
        goldenStdout(
          'administration',
          'archival-workflow',
          JSON.stringify({ database: url }),
          undefined,
          fixturePlaceholders(url),
        ),
      ) as unknown,
    );
    expect(source.routeIds).toEqual([
      'stores/urls.py:15',
      'stores/urls.py:16',
      'users/urls.py:19',
      'users/urls.py:20',
    ]);
    // Legacy archival keeps history: the source run changed no order or assignment row.
    expect(await history()).toBe(before);
    for (const legacy of source.cases) {
      const table = legacy.resource === 'stores' ? 'stores' : 'pos_user';
      const id =
        legacy.resource === 'stores'
          ? '2'
          : legacy.self
            ? '1'
            : legacy.targetRole === 2
              ? '2'
              : '30';
      const route = legacy.resource === 'stores' ? 'stores' : 'operators';
      await setActive(table, id, legacy.initialActive);
      const headers: Record<string, string> = { origin: stack.origin };
      if (legacy.actorRole !== null) {
        headers.cookie = await stack.cookie(String(legacy.actorRole));
        headers['x-operator-id'] = String(legacy.actorRole);
      }
      const response = await stack.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/${route}/${id}/status`,
        headers,
        payload: { active: legacy.action === 'activate' },
      });
      const context = JSON.stringify({ ...legacy, rewriteStatus: response.statusCode });
      const changed = legacy.initialActive !== legacy.active;
      // The legacy outcome is its row change; the rewrite answers a refused change with the
      // status that fits (401 anonymous, 403 role/ownership) instead of a redirect or a
      // "success"-labelled "Permission denied" body (S4).
      expect(response.statusCode, context).toBe(
        changed ? 200 : legacy.actorRole === null ? 401 : 403,
      );
      expect(await active(table, id), context).toBe(legacy.active);
      expect(legacy.retainedId).toBe(true);
      expect(await history(), context).toBe(before);
      await setActive(table, id, true);
    }
  }, 120000);
});
