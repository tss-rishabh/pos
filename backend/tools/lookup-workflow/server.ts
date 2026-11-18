/** Private IPC fixture driver; the listening application is the real buildApp. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { identityService } from '../../src/auth/identity.js';
import { seal } from '../../src/auth/crypto.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { readConfig } from '../../src/config.js';
import { POSFranchise, TssSetting, UserStore } from '../../src/db/legacy-schema.js';
import {
  deliverablePincodes,
  locationZones,
} from '../../src/modules/administration/location-schema.js';
import { barcodeFixture } from '../administration/barcodes/fixture.js';
import { initializeMessage, commandMessage, oracleResult } from './contracts.js';

const indexesSchema = z.object({
  indexes: z
    .record(
      z.string(),
      z.array(
        z.object({
          name: z.string(),
          column: z.string(),
          position: z.number(),
          unique: z.boolean(),
        }),
      ),
    )
    .default({}),
});
const searches = [null, '', 'in', 'INDIA', 'cote', '%', '_', '\\', "'", ' ', ' none '];
const postals = [null, '', '400001', '999999'];
let fixture: Awaited<ReturnType<typeof barcodeFixture>> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let initialFingerprint: string;

async function fingerprint() {
  if (!fixture) throw new Error('FIXTURE_NOT_READY');
  const rows: unknown[] = [];
  for (const table of ['countries', 'zones', 'deliverable_pincodes']) {
    const [current] = await fixture.admin.query<RowDataPacket[]>(
      'SELECT * FROM ' + mysql.escapeId(table) + ' ORDER BY id',
    );
    rows.push(current);
  }
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
async function close() {
  await app?.close();
  app = undefined;
  await fixture?.close();
  fixture = undefined;
}

async function initialize(raw: unknown) {
  const input = initializeMessage.parse(raw),
    url = new URL(input.database);
  if (
    url.protocol !== 'mysql:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/pos_rewrite_lookup_workflow_test' ||
    url.search ||
    url.hash
  )
    throw new Error('EXPLICIT_LOCAL_LOOKUP_FIXTURE_REQUIRED');
  const web = new URL(input.webOrigin);
  if (web.protocol !== 'http:' || web.hostname !== '127.0.0.1' || !web.port || web.pathname !== '/')
    throw new Error('EXPLICIT_LOCAL_BROWSER_ORIGIN_REQUIRED');
  fixture = await barcodeFixture(input.database);
  await fixture.reset();
  const extras = [UserStore, POSFranchise, TssSetting, deliverablePincodes, locationZones].map(
    getTableName,
  );
  await fixture.fixture.create(extras);
  const metadata = indexesSchema.parse(
    JSON.parse(readFileSync('evidence/mysql-extra-schema.json', 'utf8')) as unknown,
  );
  for (const table of extras) {
    const indexes = new Map<
      string,
      { unique: boolean; columns: { name: string; position: number }[] }
    >();
    for (const row of metadata.indexes[table] ?? []) {
      if (row.name === 'PRIMARY') continue;
      const index = indexes.get(row.name) ?? { unique: row.unique, columns: [] };
      index.columns.push({ name: row.column, position: row.position });
      indexes.set(row.name, index);
    }
    for (const [name, index] of indexes)
      await fixture.admin.query(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${mysql.escapeId(name)} ON ${mysql.escapeId(table)}(${index.columns
          .sort((a, b) => a.position - b.position)
          .map((column) => mysql.escapeId(column.name))
          .join(',')})`,
      );
  }
  for (const path of [
    'migrations/0002_auth_sessions.sql',
    'migrations/0006_operator_auth_epochs.sql',
  ])
    for (const statement of readFileSync(path, 'utf8')
      .split(';')
      .filter((value) => value.trim()))
      await fixture.admin.query(statement);
  for (const [id, name, status, secondary] of [
    ['1', 'India', 1, 1],
    ['2', 'Indonesia', 1, 0],
    ['3', 'Inactive India', 0, 1],
    ['4', "Côte d'Ivoire", 1, 1],
    ['5', 'Percent % land', 1, 1],
    ['6', 'Under_score', 1, 1],
    ['7', 'Back\\slash', 1, 1],
    ['8', 'Hidden', 0, 0],
    ['99', 'Fixture country', 1, 0],
  ] as const)
    await fixture.seed('countries', { id, name, status, sec_status: secondary });
  await fixture.seed('zones', { id: 42, name: 'Fixture state' });
  for (const [id, city, latitude] of [
    ['9007199254740993', 'straße', '19.0000000000000001'],
    ['9007199254740994', 'Other City', '20.5'],
  ] as const)
    await fixture.seed('deliverable_pincodes', {
      id,
      city,
      pincode: '400001',
      state_id: 42,
      country_id: 99,
      latitude,
      longitude: '72.0000000000000001',
    });
  const sourceRun = spawnSync(input.python, ['-B', 'tools/lookup-workflow/source-oracle.py'], {
    input: JSON.stringify({
      database: fixture.url,
      sourceRoot: input.sourceRoot,
      countries: searches,
      postals,
    }),
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, TZ: 'UTC' },
  });
  if (sourceRun.status !== 0) throw new Error('NATIVE_LOOKUP_SOURCE_ORACLE_FAILED');
  const source = oracleResult.parse(JSON.parse(sourceRun.stdout) as unknown);
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    SESSION_SECRET: 'synthetic-lookup-session-secret-'.repeat(3),
    MYSQL_WRITER_URL: fixture.url,
    MYSQL_PRIMARY_READER_URL: fixture.url,
    MYSQL_DATA_READER_URL: fixture.url,
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    BUSINESS_TIMEZONE: 'Asia/Kolkata',
    WEB_ORIGIN: input.webOrigin,
  });
  const identity = identityService(config, fixture.db),
    sessions = mysqlSessions(fixture.db),
    accounts = [];
  for (const role of [1, 2, 3, 4, 5] as const)
    for (const userType of [1, 2] as const) {
      const id = String(900010 + role * 2 + userType);
      await fixture.seed('pos_user', {
        id,
        username: 'lookup-' + id,
        role,
        user_type: userType,
        is_active: 1,
      });
      const user = await identity.get(id);
      if (!user) throw new Error('NATIVE_LOOKUP_IDENTITY_UNAVAILABLE');
      const credential = await sessions.create(id);
      accounts.push({ user, cookie: seal({ id, ...credential }, config.SESSION_SECRET) });
    }
  initialFingerprint = await fingerprint();
  app = await buildApp(config);
  const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  const [version] = await fixture.admin.query<RowDataPacket[]>('SELECT VERSION() AS version');
  process.send?.({
    kind: 'ready',
    apiOrigin,
    accounts,
    searches,
    postals,
    source,
    nativeLookupRows: 12,
    mysqlVersion: String(version[0]?.version),
  });
}

let initialized = false;
process.on('message', (raw: unknown) => {
  void (async () => {
    if (!initialized) {
      initialized = true;
      await initialize(raw);
      return;
    }
    const command = commandMessage.parse(raw);
    if (command.kind === 'close') {
      const unchanged = (await fingerprint()) === initialFingerprint;
      await close();
      process.send?.({ kind: 'closed', lookupRowsUnchanged: unchanged });
      process.disconnect?.();
    } else if (command.kind === 'fingerprint') {
      process.send?.({
        kind: 'fingerprint',
        lookupRowsUnchanged: (await fingerprint()) === initialFingerprint,
      });
    } else {
      if (!fixture) throw new Error('FIXTURE_NOT_READY');
      await fixture.admin.execute('UPDATE pos_user SET is_active=0 WHERE id=?', [
        command.operatorId,
      ]);
      process.send?.({ kind: 'disabled', operatorId: command.operatorId });
    }
  })().catch(async (error: unknown) => {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'LOOKUP_WORKFLOW_FIXTURE_FAILED';
    const driverCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z_0-9]+$/.test(error.code)
        ? error.code
        : null;
    process.send?.({
      kind: 'error',
      code,
      errorKind: error instanceof Error ? error.name : 'UnknownError',
      driverCode,
      location:
        error instanceof Error
          ? error.stack
              ?.split('\n')
              .slice(1)
              .find((line) => line.includes('lookup-workflow/server.ts'))
              ?.trim()
          : null,
    });
    await close().catch(() => undefined);
    process.exitCode = 1;
    process.disconnect?.();
  });
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void close().finally(() => process.exit(1));
  });
process.on('disconnect', () => {
  void close().catch(() => undefined);
});
process.send?.({ kind: 'awaiting-initialization' });
