/** Owned local MySQL identities/sessions and the real application; no API stubs. */
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import { identityService } from '../../src/auth/identity.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { POSFranchise, StoreCounter, TssSetting, UserStore } from '../../src/db/legacy-schema.js';
import { splitMigration } from '../../src/db/migrations.js';
import { barcodeFixture } from '../administration/barcodes/fixture.js';

export async function nativeShortcutReferenceFixture(template: string, webOrigin: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/pos_rewrite_shortcut_reference_test' ||
    url.search ||
    url.hash
  )
    throw new Error('An explicit owned localhost shortcut fixture is required');
  const web = new URL(webOrigin);
  if (web.protocol !== 'http:' || web.hostname !== '127.0.0.1' || !web.port || web.pathname !== '/')
    throw new Error('An explicit localhost browser fixture is required');
  const fixture = await barcodeFixture(template);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await fixture.fixture.create(
      [UserStore, POSFranchise, TssSetting, StoreCounter].map(getTableName),
    );
    for (const file of [
      'migrations/0002_auth_sessions.sql',
      'migrations/0006_operator_auth_epochs.sql',
      'src/modules/administration/migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(file, 'utf8')))
        await fixture.admin.query(statement);
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      WEB_ORIGIN: web.origin,
      SESSION_SECRET: 'synthetic-native-shortcut-reference-'.repeat(3),
      MYSQL_WRITER_URL: fixture.url,
      MYSQL_PRIMARY_READER_URL: fixture.url,
      MYSQL_DATA_READER_URL: fixture.url,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    });
    const identity = identityService(config, fixture.db);
    const sessions = mysqlSessions(fixture.db);
    const accounts = [];
    for (const role of [1, 2, 3, 4, 5] as const)
      for (const userType of [1, 2] as const) {
        const id = String(990100 + role * 10 + userType);
        await fixture.seed('pos_user', {
          id,
          username: `shortcut-${id}`,
          role,
          user_type: userType,
          is_active: 1,
          is_staff: 1,
        });
        const user = await identity.get(id);
        if (!user || user.role !== role || user.storeIds.length !== 0)
          throw new Error('Native unassigned shortcut identity did not qualify');
        const credential = await sessions.create(id, Date.now() + 300000);
        accounts.push({
          user,
          cookie: {
            name: 'pos_session',
            value: seal({ id, ...credential }, config.SESSION_SECRET),
            url: web.origin,
            httpOnly: true,
            sameSite: 'Lax' as const,
          },
          valid: () => sessions.valid(id, credential),
        });
      }
    app = await buildApp(config, { logger: false });
    const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      apiOrigin,
      accounts,
      async unassigned() {
        for (const table of [
          'stores',
          'store_counters',
          'user_stores',
          'pos_rewrite_operator_checkins',
        ]) {
          const [rows] = await fixture.admin.query('SELECT COUNT(*) AS total FROM `' + table + '`');
          if (
            !Array.isArray(rows) ||
            rows.length !== 1 ||
            typeof rows[0] !== 'object' ||
            rows[0] === null ||
            !('total' in rows[0]) ||
            Number(rows[0].total) !== 0
          )
            throw new Error('A shortcut fixture acquired an operational assignment');
        }
        return true;
      },
      async close() {
        await app?.close();
        await identity.close();
        await fixture.close();
      },
    };
  } catch (error) {
    await app?.close();
    await fixture.close();
    throw error;
  }
}
