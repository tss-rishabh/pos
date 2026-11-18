import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  reportExportService,
  reportExportBuilder,
  type ExportBuilder,
} from '../../src/modules/operational-reports/export-service.js';
import {
  reportExportOptions,
  type ReportExportStore,
} from '../../src/modules/operational-reports/export-storage.js';
import {
  exportHistoryInputSchema,
  type ReportExportListRow,
} from '../../src/modules/operational-reports/export-history.js';
import {
  performanceOptions,
  staffPerformanceService,
} from '../../src/modules/operational-reports/performance.js';

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('durable report exports on isolated local MySQL', () => {
  const schema = `pos_rewrite_exports_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    user: Principal = {
      id: '900001',
      name: 'Fixture',
      email: 'fixture@example.test',
      role: 4,
      userType: 1,
      storeIds: ['1'],
    },
    options = reportExportOptions({ REPORT_EXPORT_MAX_PENDING_PER_USER: '3' }),
    input = {
      kind: 'day-close-history',
      from: '2026-11-16',
      to: '2026-11-16',
      storeIds: ['1'],
      attempts: 'all',
      search: '',
    } as const;
  let admin: mysql.Connection | undefined,
    database: Databases | undefined,
    created = false,
    now = Temporal.Instant.from('2026-11-16T12:00:00Z'),
    buildCount = 0,
    putCount = 0,
    headCount = 0,
    streamCount = 0,
    uploadFailure = false,
    buildFailure = false;
  let artifacts = new Map<string, { bytes: Buffer; checksum: string }>();
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'export-integration-fixture-'.repeat(3),
  });
  const store: ReportExportStore = {
    keyFor: (id) => `uploads/reports/pos-rewrite/${id}.csv`,
    async put(id, bytes, checksum) {
      putCount++;
      artifacts.set(this.keyFor(id), { bytes, checksum });
      if (uploadFailure) throw new Error('fixture transport failure with secret details');
    },
    async head(key) {
      headCount++;
      const item = artifacts.get(key);
      return item ? { size: item.bytes.length, checksum: item.checksum } : null;
    },
    async stream(key, expected) {
      streamCount++;
      const item = artifacts.get(key);
      if (
        !item ||
        (expected && (expected.size !== item.bytes.length || expected.checksum !== item.checksum))
      )
        throw new Error('fixture artifact mismatch');
      return { body: Readable.from(item.bytes), size: item.bytes.length };
    },
    close() {},
  };
  const builder: ExportBuilder = async (actor, value) => {
    buildCount++;
    if (buildFailure) throw new Error('fixture database error with private query values');
    expect(actor.name).toBe('');
    expect(value.storeIds).toEqual(['1']);
    return { bytes: Buffer.from('"Store","Difference"\r\n"Fixture","-5.00"'), rowCount: 1 };
  };
  function db() {
    if (!database) throw new Error('Fixture not initialized');
    return database;
  }
  function service() {
    return reportExportService(config, db(), options, store, builder, () => now);
  }
  async function resetAccess() {
    await admin!.query('UPDATE pos_user SET role=4,user_type=1,is_active=1 WHERE id=900001');
    await admin!.query('DELETE FROM user_stores');
    await admin!.query('INSERT INTO user_stores VALUES(1,900001,1),(2,900002,2)');
    await admin!.query('UPDATE pos_user SET role=1,user_type=1,is_active=1 WHERE id=900003');
  }
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Export integration fixtures require local MySQL.');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await admin.changeUser({ database: schema });
    await admin.query(
      'CREATE TABLE pos_user(id BIGINT PRIMARY KEY,username VARCHAR(150),role SMALLINT,is_active BOOLEAN,user_type SMALLINT)',
    );
    await admin.query(
      "INSERT INTO pos_user VALUES(900001,'fixture-one',4,1,1),(900002,'fixture-two',4,1,1),(900003,'fixture-admin',1,1,1)",
    );
    await admin.query(
      'CREATE TABLE user_stores(id BIGINT PRIMARY KEY,django_user_id BIGINT,store_id BIGINT)',
    );
    await admin.query(
      'CREATE TABLE report_exports(id BIGINT PRIMARY KEY,report_name VARCHAR(255),report_type VARCHAR(255),time_period VARCHAR(55),is_completed BOOLEAN,export_status VARCHAR(55),message VARCHAR(255),export_requested_by INT,export_requested_at DATETIME,export_completed_at DATETIME,export_file_url VARCHAR(255),export_format VARCHAR(10),export_size INT,export_rows_count INT,created_at DATETIME,updated_at DATETIME)',
    );
    await admin.query(
      "INSERT INTO report_exports VALUES(1,'Fixture legacy report','report',NULL,1,'COMPLETED','private raw error must never be returned',900001,'2026-11-16 12:00:00','2026-11-16 12:01:00','uploads/reports/history/file.csv','CSV',1,3,'2026-11-16 12:00:00','2026-11-16 12:01:00'),(2,'Another report','report',NULL,0,'FAILED','secret query',900002,'2026-11-16 11:00:00',NULL,'','CSV',0,0,'2026-11-16 11:00:00','2026-11-16 11:00:00')",
    );
    for (const statement of readFileSync('src/modules/operational-reports/migration.sql', 'utf8')
      .split(';')
      .filter((value) => value.trim()))
      await admin.query(statement);
    url.pathname = '/' + schema;
    database = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'export-mysql-config-'.repeat(3),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  beforeEach(async () => {
    now = Temporal.Instant.from('2026-11-16T12:00:00Z');
    buildCount = putCount = headCount = streamCount = 0;
    uploadFailure = buildFailure = false;
    artifacts = new Map();
    await admin!.query('DELETE FROM pos_rewrite_report_exports');
    await resetAccess();
    await admin!.query(
      "UPDATE report_exports SET export_requested_at='2026-11-16 12:00:00',updated_at='2026-11-16 12:00:00',export_completed_at=CASE WHEN is_completed=1 THEN '2026-11-16 12:01:00' ELSE NULL END",
    );
  });
  afterAll(async () => {
    await database?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });
  it('freezes store scope, deduplicates concurrent retries and builds an immutable verified file once', async () => {
    const exports = service(),
      command = randomUUID(),
      [first, retry] = await Promise.all([
        exports.create(user, command, input, 'fixture-request'),
        exports.create(user, command, { ...input, storeIds: ['1', '1'] }, 'retry-request'),
      ]);
    expect(first.id).toBe(retry.id);
    expect(first.status).toBe('QUEUED');
    await expect(
      exports.create(user, command, { ...input, attempts: 'latest' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const results = await Promise.all([exports.runOne(), exports.runOne()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      jobId: first.id,
      status: 'COMPLETED',
      userId: user.id,
    });
    expect(['fixture-request', 'retry-request']).toContain(results.find(Boolean)?.requestId);
    expect(buildCount).toBe(1);
    expect(putCount).toBe(1);
    const receipt = await exports.read(user, first.id);
    expect(receipt).toMatchObject({ canDownload: true, rowCount: 1, format: 'CSV' });
    const download = await exports.download(user, first.id),
      chunks: Buffer[] = [];
    for await (const chunk of download.body)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    expect(Buffer.concat(chunks).toString()).toContain('"-5.00"');
    expect(JSON.stringify(receipt)).not.toContain('uploads/');
    expect((await exports.list(user, 'legacy')).total).toBe(1);
  });
  it('freezes assigned stores for restricted superadmin daily and flash exports without global scope', async () => {
    await admin!.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=900001');
    const exports = service(),
      actor = { ...user, role: 1 as const, userType: 2 as const };
    for (const kind of ['hyperlocal-daily', 'flash-sales'] as const) {
      const value = {
          kind,
          from: kind === 'hyperlocal-daily' ? '2026-11-16T00:00:00' : '2026-11-16',
          to: kind === 'hyperlocal-daily' ? '2026-11-16T23:59:59' : '2026-11-16',
          storeIds: [],
        },
        job = await exports.create(actor, randomUUID(), value);
      expect(await exports.runOne()).toMatchObject({ jobId: job.id, status: 'COMPLETED' });
      await admin!.query('DELETE FROM user_stores WHERE django_user_id=900001');
      await expect(exports.download(actor, job.id)).rejects.toMatchObject({
        code: 'EXPORT_ACCESS_DENIED',
      });
      await admin!.query('INSERT INTO user_stores VALUES(1,900001,1)');
    }
  });
  it('reconciles a lost upload response using the saved checksum without rebuilding or retrying PUT', async () => {
    uploadFailure = true;
    const exports = service(),
      job = await exports.create(user, randomUUID(), input);
    expect(await exports.runOne()).toMatchObject({
      status: 'STORING',
      errorCode: 'UPLOAD_OUTCOME_UNKNOWN',
    });
    expect(await exports.runOne()).toBeNull();
    now = now.add({ seconds: 16 });
    expect(await exports.runOne()).toMatchObject({ status: 'COMPLETED' });
    expect(buildCount).toBe(1);
    expect(putCount).toBe(1);
    expect(headCount).toBe(1);
    expect((await exports.read(user, job.id)).canDownload).toBe(true);
  });
  it('builds a full manager column export once, recovers lost upload and rechecks current manager authority', async () => {
    await admin!.query('UPDATE pos_user SET role=1 WHERE id=900001');
    let factReads = 0;
    const performance = staffPerformanceService(
        config,
        db(),
        performanceOptions({
          BQ_SALESPERSON_PERFORMANCE_VIEW: 'fixture-project.reports.salespeople',
        }),
        {
          async queryReport() {
            factReads++;
            return Array.from({ length: 61 }, (_, i) => ({
              employeeId: String(i + 1),
              storeName: 'not exported',
              salespersonName: i === 60 ? '=private formula' : `Staff ${i}`,
              totalSales: 610 - 10 * i,
            }));
          },
        },
        () => now,
      ),
      exports = reportExportService(
        config,
        db(),
        options,
        store,
        reportExportBuilder(config, db(), { performance }),
        () => now,
      ),
      command = randomUUID(),
      selected = {
        kind: 'salesperson-performance',
        from: '2026-11-15T00:00:00',
        to: '2026-11-15T23:59:59',
        storeIds: ['1'],
        columns: ['salesperson_name', 'rating'],
        sort: 'total_sales',
        direction: 'desc',
      },
      job = await exports.create(user, command, selected);
    expect((await exports.create(user, command, selected)).id).toBe(job.id);
    await expect(
      exports.create(user, command, { ...selected, columns: ['rating'] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    uploadFailure = true;
    expect(await exports.runOne()).toMatchObject({ status: 'STORING' });
    expect(factReads).toBe(1);
    now = now.add({ seconds: 16 });
    expect(await exports.runOne()).toMatchObject({ status: 'COMPLETED' });
    const file = await exports.download(user, job.id),
      chunks: Buffer[] = [];
    for await (const chunk of file.body) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString();
    expect(csv.split('\r\n')).toHaveLength(62);
    expect(csv).toContain('"\'=private formula","0.2"');
    expect(csv).not.toContain('not exported');
    expect(factReads).toBe(1);
    expect(putCount).toBe(1);
    expect(headCount).toBe(1);
    await admin!.query('UPDATE pos_user SET role=4 WHERE id=900001');
    await expect(exports.read(user, job.id)).rejects.toMatchObject({
      code: 'EXPORT_ACCESS_DENIED',
    });
    await expect(exports.download(user, job.id)).rejects.toMatchObject({
      code: 'EXPORT_ACCESS_DENIED',
    });
    await expect(
      exports.create({ ...user, role: 1 }, randomUUID(), selected),
    ).rejects.toMatchObject({ code: 'EXPORT_ACCESS_DENIED' });
  });
  it('refuses manager export dispatch after role/assignment revocation and does not broaden empty franchise scope', async () => {
    await admin!.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=900001');
    const exports = service(),
      actor = { ...user, role: 1 as const, userType: 2 as const };
    for (const kind of [
      'salesperson-performance',
      'cashier-performance',
      'hyperlocal-acceptance',
    ] as const) {
      const selected = {
        kind,
        from: '2026-11-15T00:00:00',
        to: '2026-11-15T23:59:59',
        storeIds: ['1'],
      };
      await expect(
        exports.create(actor, randomUUID(), { ...selected, storeIds: ['2'] }),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      const job = await exports.create(actor, randomUUID(), selected);
      await admin!.query('UPDATE pos_user SET role=4 WHERE id=900001');
      expect(await exports.runOne()).toMatchObject({
        jobId: job.id,
        status: 'FAILED',
        errorCode: 'EXPORT_ACCESS_DENIED',
      });
      await admin!.query('UPDATE pos_user SET role=1 WHERE id=900001');
    }
    expect(buildCount).toBe(0);
    const job = await exports.create(actor, randomUUID(), {
      kind: 'salesperson-performance',
      from: '2026-11-15T00:00:00',
      to: '2026-11-15T23:59:59',
      storeIds: [],
    });
    const [rows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT store_ids,requires_global FROM pos_rewrite_report_exports WHERE id=?',
      [job.id],
    );
    expect(rows[0]?.store_ids).toEqual([]);
    expect(rows[0]?.requires_global).toBe(0);
  });
  it('fails unavailable or interrupted artifacts safely without exposing query errors', async () => {
    const exports = service();
    buildFailure = true;
    const failed = await exports.create(user, randomUUID(), input);
    expect(await exports.runOne()).toMatchObject({
      status: 'FAILED',
      errorCode: 'EXPORT_BUILD_FAILED',
    });
    expect(JSON.stringify(await exports.read(user, failed.id))).not.toContain('private');
    expect(putCount).toBe(0);
    buildFailure = false;
    uploadFailure = true;
    const missing = await exports.create(user, randomUUID(), input);
    await exports.runOne();
    artifacts.clear();
    now = now.add({ seconds: 16 });
    expect(await exports.runOne()).toMatchObject({
      status: 'FAILED',
      errorCode: 'EXPORT_ARTIFACT_MISSING',
    });
    expect(buildCount).toBe(2);
    expect((await exports.read(user, missing.id)).canDownload).toBe(false);
    const stale = await exports.create(user, randomUUID(), input);
    await admin!.query(
      "UPDATE pos_rewrite_report_exports SET status='BUILDING',claim_token=?,lease_until='2026-11-16 11:59:00.000' WHERE id=?",
      [randomUUID(), stale.id],
    );
    expect(await exports.runOne()).toBeNull();
    expect((await exports.read(user, stale.id)).status).toBe('FAILED');
  });
  it('checks writer-current store, role, user type and account access before file operations', async () => {
    const exports = service(),
      job = await exports.create(user, randomUUID(), input);
    await exports.runOne();
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=900001');
    await expect(exports.download(user, job.id)).rejects.toMatchObject({
      code: 'EXPORT_ACCESS_DENIED',
    });
    expect(streamCount).toBe(0);
    await resetAccess();
    await admin!.query('UPDATE pos_user SET user_type=2 WHERE id=900001');
    await expect(exports.download(user, job.id)).rejects.toMatchObject({
      code: 'EXPORT_ACCESS_DENIED',
    });
    expect(streamCount).toBe(0);
    await resetAccess();
    await admin!.query('UPDATE pos_user SET is_active=0 WHERE id=900001');
    await expect(exports.read(user, job.id)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await resetAccess();
    await admin!.query('UPDATE pos_user SET role=1 WHERE id=900001');
    const global = await exports.create({ ...user, role: 1 }, randomUUID(), {
      ...input,
      storeIds: [],
    });
    await admin!.query('UPDATE pos_user SET role=4 WHERE id=900001');
    expect(await exports.runOne()).toMatchObject({
      jobId: global.id,
      status: 'FAILED',
      errorCode: 'EXPORT_ACCESS_DENIED',
    });
    await expect(
      exports.read({ ...user, id: '900002', storeIds: ['2'] }, job.id),
    ).rejects.toMatchObject({ code: 'EXPORT_ACCESS_DENIED' });
  });
  it('preserves explicit empty selection for return exports and checks restricted role1 assignments', async () => {
    const selected: string[][] = [],
      exports = reportExportService(
        config,
        db(),
        options,
        store,
        async (_user, value) => {
          selected.push(value.storeIds);
          return { bytes: Buffer.from('"Store Name"'), rowCount: 0 };
        },
        () => now,
      ),
      value = {
        kind: 'returned-orders',
        from: '2026-11-16T00:00:00',
        to: '2026-11-16T23:59:59',
        storeIds: [],
      };
    const job = await exports.create(user, randomUUID(), value);
    await exports.runOne();
    expect(selected).toEqual([[]]);
    expect((await exports.read(user, job.id)).status).toBe('COMPLETED');
    await admin!.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=900001');
    await expect(
      exports.create({ ...user, role: 1, userType: 2 }, randomUUID(), {
        ...value,
        storeIds: ['2'],
      }),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
  });
  it('limits pending work per operator and rechecks scope before creating a queue row', async () => {
    const exports = service();
    for (let index = 0; index < 3; index++) await exports.create(user, randomUUID(), input);
    await expect(exports.create(user, randomUUID(), input)).rejects.toMatchObject({
      code: 'EXPORT_QUEUE_LIMIT',
    });
    await expect(
      exports.create(user, randomUUID(), { ...input, storeIds: ['2'] }),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=900001');
    await expect(exports.create(user, randomUUID(), input)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });
  it('keeps old pending state on primary and uses warehouse history with writer-only file eligibility', async () => {
    const initial = service(),
      completed = await initial.create(user, randomUUID(), input);
    await initial.runOne();
    const receipt = await initial.read(user, completed.id),
      pending = await initial.create(user, randomUUID(), input);
    await admin!.query(
      "UPDATE pos_rewrite_report_exports SET requested_at='2026-11-14 12:00:00',updated_at='2026-11-14 12:00:00',completed_at=CASE WHEN status='COMPLETED' THEN '2026-11-14 12:01:00' ELSE NULL END",
    );
    const recent = await initial.list(user, 'current');
    expect(recent.reader).toBe('primary');
    expect(recent.data.map((row) => row.id)).toEqual([pending.id]);
    const archived: ReportExportListRow = {
        ...receipt,
        requestedAt: '2026-11-14T12:00:00Z',
        completedAt: '2026-11-14T12:01:00Z',
      },
      roles: number[] = [],
      exports = reportExportService(config, db(), options, store, builder, () => now, {
        async list(current, value) {
          roles.push(current.role);
          return { data: [archived], total: 1, page: 1, pageSize: value.pageSize };
        },
      }),
      selection = exportHistoryInputSchema.parse({
        period: 'archive',
        from: '2026-11-01',
        to: '2026-11-15',
      }),
      history = await exports.list(user, selection);
    expect(history.reader).toBe('bigquery');
    expect(history.data[0]).toMatchObject({ canDownload: true, requestedByName: 'fixture-one' });
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=900001');
    expect((await exports.list({ ...user, role: 1 }, selection)).data[0]?.canDownload).toBe(false);
    expect(roles).toEqual([4, 4]);
    expect(streamCount).toBe(0);
  });
  it('keeps legacy history owner-scoped, suppresses raw messages and requires current internal role1 for unscoped files', async () => {
    const exports = service(),
      own = await exports.list(user, 'legacy');
    expect(own.total).toBe(1);
    expect(own.data[0]).toMatchObject({ canDownload: false, status: 'COMPLETED' });
    expect(JSON.stringify(own)).not.toContain('raw error');
    await expect(exports.downloadLegacy(user, '1')).rejects.toMatchObject({
      code: 'EXPORT_ACCESS_DENIED',
    });
    expect(streamCount).toBe(0);
    const superuser = { ...user, id: '900003', role: 1 as const, storeIds: [] },
      all = await exports.list(superuser, 'legacy');
    expect(all.total).toBe(2);
    expect(all.data.some((job) => job.status === 'FAILED')).toBe(true);
    const bytes = Buffer.from('legacy fixture');
    artifacts.set('uploads/reports/history/file.csv', {
      bytes,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
    expect((await exports.downloadLegacy(superuser, '1')).size).toBe(bytes.length);
    await admin!.query('UPDATE pos_user SET user_type=2 WHERE id=900003');
    expect((await exports.list(superuser, 'legacy')).data.every((row) => !row.canDownload)).toBe(
      true,
    );
    await expect(exports.downloadLegacy(superuser, '1')).rejects.toMatchObject({
      code: 'EXPORT_ACCESS_DENIED',
    });
    await admin!.query('UPDATE pos_user SET user_type=1,role=4 WHERE id=900003');
    await expect(exports.downloadLegacy(superuser, '1')).rejects.toMatchObject({
      code: 'EXPORT_ACCESS_DENIED',
    });
    const [rows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM report_exports',
    );
    expect(rows[0]?.total).toBe(2);
  });
});
