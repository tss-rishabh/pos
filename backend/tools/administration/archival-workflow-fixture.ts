/** Native authority for a bounded archival workflow; only an owned local schema. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { identityService } from '../../src/auth/identity.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { splitMigration } from '../../src/db/migrations.js';
import { barcodeFixture } from './barcodes/fixture.js';

const sourceResult = z.object({
  sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
  routeIds: z.array(z.enum(['stores/urls.py:15', 'stores/urls.py:16', 'users/urls.py:19', 'users/urls.py:20'])).length(4),
  hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  cases: z.array(z.object({
    resource: z.enum(['stores', 'users']), actorRole: z.number().nullable(), targetRole: z.number(),
    self: z.boolean(), action: z.enum(['delete', 'activate']), httpStatus: z.number(),
    sourceStatus: z.string().nullable(), permissionDenied: z.boolean(), initialActive: z.boolean(),
    active: z.boolean(), retainedId: z.boolean(),
  })).length(12),
});

export async function archivalWorkflowFixture(connection: string, webOrigin: string, source: string) {
  const url = new URL(connection), web = new URL(webOrigin);
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.port === '54777' || url.pathname !== '/pos_rewrite_archival_workflow' || url.search || url.hash)
    throw new Error('An owned local archival fixture is required');
  if (web.protocol !== 'http:' || web.hostname !== '127.0.0.1' || !web.port || web.pathname !== '/')
    throw new Error('An explicit local browser origin is required');
  const native = await barcodeFixture(connection);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let identity: ReturnType<typeof identityService> | undefined;
  try {
    await native.fixture.create(['user_stores', 'pos_franchise', 'tss_settings', 'store_counters', 'orders', 'order_stores']);
    for (const filename of ['migrations/0002_auth_sessions.sql', 'migrations/0006_operator_auth_epochs.sql', 'src/modules/administration/migration.sql'])
      for (const statement of splitMigration(readFileSync(filename, 'utf8')))
        await native.admin.query(statement);
    for (const id of ['1', '2']) {
      await native.seed('stores', { id, store_name: `Archival fixture store ${id}`, short_name: `ARC${id}`,
        type: 'STORE', category: 'IN_HOUSE', location_code: `ARC${id}`, is_active: 1,
        url_key: `https://thesouledstore.com/?store_id=${id}` });
      await native.seed('store_counters', { id, store_id: id, counter_name: `ARC${id}`, is_active: 1 });
    }
    for (const [id, role, userType] of [['1', 1, 1], ['2', 2, 1], ['3', 3, 1], ['4', 4, 1], ['5', 5, 1], ['11', 1, 2], ['30', 4, 1]] as const) {
      await native.seed('pos_user', { id, username: `archival-${id}`, first_name: `Archival ${id}`,
        last_name: 'Fixture', role, user_type: userType, is_active: 1, is_staff: 1 });
      for (const store of ['1', '2'])
        await native.seed('user_stores', { django_user_id: id, store_id: store });
    }
    await native.seed('orders', { id: '70001', user_id: '777', order_amt: '25.49', pay_amt: '25.49' });
    await native.seed('order_stores', { id: '70001', order_id: '70001', store_id: '2', counter_id: '2',
      admin_user_id: '30', offline_payment: '25.49', offline_payment_recieved: '25.49', order_invoice: 'SYNTHETIC-ARCHIVAL-RETAINED' });
    const python = process.env.ARCHIVAL_WORKFLOW_ORACLE_PYTHON;
    if (!python) throw new Error('A private pinned Django/PyMySQL interpreter is required');
    const sourceHistory = await history();
    const oracle = spawnSync(python, ['-B', 'tools/administration/archival-workflow-source.py'], {
      input: JSON.stringify({ database: native.url, source }), encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    if (oracle.status !== 0) throw new Error('Pinned archival source dispatch failed');
    const original = sourceResult.parse(JSON.parse(oracle.stdout) as unknown);
    if (await history() !== sourceHistory) throw new Error('Source archival changed retained history');
    const config = readConfig({ NODE_ENV: 'test', DEMO_MODE: 'false', WEB_ORIGIN: web.origin,
      SESSION_SECRET: 'synthetic-archival-workflow-session-'.repeat(3), MYSQL_WRITER_URL: native.url,
      MYSQL_PRIMARY_READER_URL: native.url, MYSQL_DATA_READER_URL: native.url, MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true' });
    identity = identityService(config, native.db);
    const sessions = mysqlSessions(native.db);
    async function account(id: string) {
      const user = await identity!.get(id);
      if (!user) throw new Error('Native archival identity did not qualify');
      const credential = await sessions.create(id, Date.now() + 600000);
      return { cookie: { name: 'pos_session', value: seal({ id, ...credential }, config.SESSION_SECRET),
        url: web.origin, httpOnly: true, sameSite: 'Lax' as const },
      valid: () => sessions.valid(id, credential) };
    }
    async function active(resource: 'stores' | 'operators', id: string) {
      const table = resource === 'stores' ? 'stores' : 'pos_user';
      const [rows] = await native.admin.query('SELECT is_active FROM `' + table + '` WHERE id=?', [id]);
      const row = z.array(z.object({ is_active: z.union([z.number(), z.boolean()]) })).length(1).parse(rows)[0]!;
      return Boolean(row.is_active);
    }
    async function history() {
      const [orders] = await native.admin.query('SELECT * FROM orders WHERE id=70001');
      const [receipts] = await native.admin.query('SELECT * FROM order_stores WHERE id=70001');
      const [assignments] = await native.admin.query('SELECT * FROM user_stores ORDER BY id');
      return JSON.stringify({ orders, receipts, assignments });
    }
    app = await buildApp(config, { logger: false });
    const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { apiOrigin, original, account, active, history,
      async resetActive(resource: 'stores' | 'operators', id: string, enabled: boolean) {
        const table = resource === 'stores' ? 'stores' : 'pos_user';
        await native.admin.query('UPDATE `' + table + '` SET is_active=? WHERE id=?', [enabled, id]);
      },
      async role(id: string, role: number) { await native.admin.query('UPDATE pos_user SET role=? WHERE id=?', [role, id]); },
      async close() { await app?.close(); await identity?.close(); await native.close(); },
    };
  } catch (error) {
    await app?.close(); await identity?.close(); await native.close(); throw error;
  }
}
