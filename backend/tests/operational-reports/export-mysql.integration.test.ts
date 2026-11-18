import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { recordingJobProducer } from '../../src/jobs/module-runtime.js';
import {
  reportExportService,
  type ExportBuilder,
} from '../../src/modules/operational-reports/export-service.js';
import {
  reportExportOptions,
  type ReportExportStore,
} from '../../src/modules/operational-reports/export-storage.js';

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('legacy report export jobs E1-E6 on isolated local MySQL', () => {
  const schema = `pos_rewrite_exports_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    user: Principal = {
      id: '900001',
      name: 'Fixture',
      email: 'fixture@example.test',
      role: 4,
      userType: 1,
      storeIds: ['1'],
    },
    admin1: Principal = { ...user, id: '900003', role: 1, storeIds: [] },
    options = reportExportOptions({});
  let admin: mysql.Connection | undefined,
    database: Databases | undefined,
    created = false,
    builds: { actor: Principal; kind: string; storeIds: string[] }[] = [],
    uploads = new Map<string, Buffer>(),
    buildFailure = false,
    uploadFailure = false,
    jobs = recordingJobProducer();
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'export-integration-fixture-'.repeat(3),
  });
  let sequence = 0;
  const store: ReportExportStore = {
    keyFor: (folder) =>
      `uploads/reports/${folder}/orders_${String(++sequence).padStart(32, '0')}.csv`,
    async put(key, bytes) {
      if (uploadFailure) throw new Error('fixture transport failure with secret details');
      uploads.set(key, bytes);
    },
    async head(key) {
      const item = uploads.get(key);
      return item ? { size: item.length, checksum: null } : null;
    },
    async stream(key) {
      const item = uploads.get(key);
      if (!item) throw new Error('fixture artifact missing');
      return { body: Readable.from(item), size: item.length };
    },
    close() {},
  };
  const builder: ExportBuilder = async (actor, value) => {
    builds.push({ actor, kind: value.kind, storeIds: value.storeIds });
    if (buildFailure) throw new Error('fixture database error with private query values');
    // 2 data rows, 2050 bytes -> export_size 2 (KB, truncated) as Django's IntegerField stores it.
    return { bytes: Buffer.alloc(2050, 'a'), rowCount: 2 };
  };
  const clock = () => Temporal.Instant.from('2026-11-16T12:00:00Z');
  function db() {
    if (!database) throw new Error('Fixture not initialized');
    return database;
  }
  function service(storage: ReportExportStore | null = store) {
    return reportExportService(config, db(), options, storage ?? undefined, jobs, builder, clock, {
      stores: async (actor) => ({
        data: (actor.role === 1 ? ['1', '2'] : actor.storeIds).map((id) => ({ id, name: id })),
      }),
    });
  }
  async function rows() {
    const [result] = await admin!.query('SELECT * FROM report_exports ORDER BY id');
    return result as Record<string, unknown>[];
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
      dateStrings: true,
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await admin.changeUser({ database: schema });
    await admin.query(
      'CREATE TABLE pos_user(id BIGINT PRIMARY KEY,username VARCHAR(150),role SMALLINT,is_active BOOLEAN,user_type SMALLINT)',
    );
    await admin.query(
      'CREATE TABLE user_stores(id BIGINT PRIMARY KEY,django_user_id BIGINT,store_id BIGINT)',
    );
    // Production DDL (tests/golden/schema/production-schema.json, report_exports).
    await admin.query(
      "CREATE TABLE report_exports(id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,report_name varchar(255) NOT NULL,report_type varchar(255) NOT NULL DEFAULT '',time_period varchar(55) DEFAULT NULL,is_completed tinyint DEFAULT '0',export_status varchar(55) DEFAULT 'PENDING',message varchar(255) NOT NULL DEFAULT '',export_requested_by int NOT NULL DEFAULT '0',export_requested_at datetime DEFAULT CURRENT_TIMESTAMP,export_completed_at datetime DEFAULT NULL,export_file_url varchar(255) NOT NULL DEFAULT '',export_format varchar(10) NOT NULL DEFAULT 'CSV',export_size int NOT NULL DEFAULT '0',export_rows_count int NOT NULL DEFAULT '0',created_at datetime DEFAULT CURRENT_TIMESTAMP,updated_at datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)",
    );
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
    builds = [];
    uploads = new Map();
    buildFailure = uploadFailure = false;
    jobs = recordingJobProducer();
    await admin!.query('DELETE FROM report_exports');
    await admin!.query('DELETE FROM pos_user');
    await admin!.query(
      "INSERT INTO pos_user VALUES(900001,'fixture-one',4,1,1),(900002,'fixture-two',4,1,1),(900003,'fixture-admin',1,1,1)",
    );
    await admin!.query('DELETE FROM user_stores');
    await admin!.query('INSERT INTO user_stores VALUES(1,900001,1),(2,900002,2)');
  });
  afterAll(async () => {
    await database?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });
  it('the HTTP side only validates and enqueues the legacy task with its filters (no row yet)', async () => {
    const exports = service();
    await expect(
      exports.create(user, {
        kind: 'returned-orders',
        from: '2026-11-16T10:00',
        to: '2026-11-16T11:30',
        storeIds: ['1'],
        label: 'Returns',
        note: 'For audit',
      }),
    ).resolves.toEqual({
      message:
        'Records are being exported to CSV. The file will be available in the Export tab shortly. Click here to open the Export tab.',
    });
    await exports.create(user, {
      kind: 'flash-sales',
      from: '2026-11-01',
      to: '2026-11-16',
      storeIds: ['1'],
    });
    await expect(
      exports.create(user, { kind: 'cash-balance', from: '2026-11-01', to: '2026-11-30' }),
    ).resolves.toMatchObject({ message: expect.stringMatching(/^Cash balance is being exported/) });
    expect(jobs.enqueued.map(({ name, options: queued }) => [name, queued.queue])).toEqual([
      ['report.datatables.return_orders_datatable.do_return_export', 'export_queue'],
      ['report.datatables.sales_data.do_sales_export', 'sales_queue'],
      ['report.datatables.cash_balance_datatable.do_cash_balance_export', 'export_queue'],
    ]);
    expect(jobs.enqueued[0]?.args).toEqual({
      user_id: '900001',
      report_name: 'Returns',
      report_message: 'For audit',
      date_from: '2026-11-16T10:00:00',
      date_to: '2026-11-16T11:30:00',
      store_ids: ['1'],
    });
    // cash_balance_datatable.py:44-66: visible stores, end date clamped to today.
    expect(jobs.enqueued[2]?.args).toMatchObject({
      store_ids: ['1'],
      date_from: '2026-11-01',
      date_to: '2026-11-16',
    });
    expect(await rows()).toEqual([]);
    await expect(
      exports.create(user, {
        kind: 'cash-balance',
        from: '2026-11-01',
        to: '2026-11-16',
        storeIds: ['2'],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=900001');
    await expect(
      exports.create(user, { kind: 'cash-balance', from: '2026-11-01', to: '2026-11-16' }),
    ).rejects.toMatchObject({ status: 400, code: 'EXPORT_STORES_REQUIRED' });
    await expect(
      service(null).create(user, {
        kind: 'cash-balance',
        from: '2026-11-01',
        to: '2026-11-16',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(jobs.enqueued).toHaveLength(3);
  });
  it('E5 creates the row, uploads the CSV and writes the legacy Completed casing, KB size and data-row count', async () => {
    const exports = service();
    await exports.create(user, {
      kind: 'day-close-history',
      from: '2026-11-10',
      to: '2026-11-16',
      storeIds: ['1'],
    });
    const [job] = jobs.enqueued;
    const id = await exports.run('day-close-history', job!.args);
    expect(builds).toEqual([
      {
        actor: expect.objectContaining({ id: '900001', role: 4 }),
        kind: 'day-close-history',
        storeIds: ['1'],
      },
    ]);
    const [row] = await rows();
    expect(String(row!.id)).toBe(id);
    expect(row).toMatchObject({
      report_name: 'Close history',
      report_type: 'DAY_CLOSE',
      time_period: '2026-11-10 - 2026-11-16',
      is_completed: 1,
      export_status: 'Completed',
      message: '',
      export_requested_by: 900001,
      export_requested_at: '2026-11-16 17:30:00',
      export_completed_at: '2026-11-16 17:30:00',
      export_format: 'CSV',
      export_size: 2,
      export_rows_count: 2,
    });
    expect(row!.export_file_url).toMatch(/^uploads\/reports\/day_close\/orders_\d{32}\.csv$/);
    expect(uploads.get(String(row!.export_file_url))).toHaveLength(2050);
  });
  it('E3/E5/E6 record FAILED on error; E1/E2/E4 leave the row Processing as legacy does', async () => {
    const exports = service();
    buildFailure = true;
    await expect(
      exports.run('hyperlocal-daily', {
        user_id: '900001',
        report_name: '',
        report_message: '',
        date_from: '2026-11-16T00:00',
        date_to: '2026-11-16T23:59',
        store_ids: ['1'],
      }),
    ).rejects.toThrow();
    buildFailure = false;
    uploadFailure = true;
    await expect(
      exports.run('returned-orders', {
        user_id: '900001',
        report_name: 'Returns',
        report_message: 'note',
        date_from: '2026-11-16T00:00',
        date_to: '2026-11-16T23:59',
        store_ids: ['1'],
      }),
    ).rejects.toThrow();
    await expect(
      exports.run('flash-sales', {
        user_id: '900001',
        report_name: '',
        report_message: '',
        date_from: '2026-11-01',
        date_to: '2026-11-16',
        store_ids: ['1'],
      }),
    ).rejects.toThrow();
    const [daily, returns, sales] = await rows();
    expect(daily).toMatchObject({
      report_type: 'HYPERLOCAL_DAILY',
      time_period: '2026-11-16 00:00:00 - 2026-11-16 23:59:00',
      export_status: 'FAILED',
      is_completed: 0,
      export_completed_at: '2026-11-16 17:30:00',
    });
    expect(returns).toMatchObject({
      report_name: 'Returns',
      message: 'note',
      report_type: 'RETURN',
      export_status: 'Processing',
      is_completed: 0,
      export_completed_at: null,
    });
    // sales_data.py:84 labels the flash/sales export RETURN.
    expect(sales).toMatchObject({
      report_type: 'RETURN',
      time_period: '2026-11-01 00:00:00 - 2026-11-16 00:00:00',
      export_status: 'Processing',
    });
  });
  it('lists own rows (superadmin: all), and streams only completed files the caller may download', async () => {
    const exports = service();
    const args = {
      user_id: '900001',
      report_name: 'Mine',
      report_message: '',
      date_from: '2026-11-16T00:00',
      date_to: '2026-11-16T23:59',
      store_ids: ['1'],
    };
    const mine = await exports.run('order-transactions', args);
    await exports.run('returned-orders', {
      ...args,
      user_id: '900002',
      report_name: 'Theirs',
      store_ids: ['2'],
    });
    await admin!.query(
      "INSERT INTO report_exports(report_name,report_type,is_completed,export_status,message,export_requested_by,export_file_url,export_format,export_size,export_rows_count) VALUES('Old','ORDER',1,'COMPLETED','',900001,'https://old-minio.example/file.csv','CSV',1,1)",
    );
    const own = await exports.list(user, {});
    expect(own.total).toBe(2);
    expect(own.data.map((row) => [row.reportName, row.canDownload])).toEqual([
      ['Old', false],
      ['Mine', true],
    ]);
    expect(own.data[1]).toMatchObject({
      kind: 'ORDER',
      status: 'COMPLETED',
      exportStatus: 'COMPLETED',
      requestedByName: 'fixture-one',
      sizeKb: 2,
      rowCount: 2,
    });
    expect(JSON.stringify(own)).not.toContain('uploads/');
    expect((await exports.list(admin1, { search: 'Theirs' })).data).toHaveLength(1);
    expect((await exports.list(admin1, {})).total).toBe(3);
    const file = await exports.download(user, mine),
      chunks: Buffer[] = [];
    for await (const chunk of file.body) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks)).toHaveLength(2050);
    expect(file.filename).toBe(`report-${mine}.csv`);
    const theirs = String((await rows()).find((row) => row.report_name === 'Theirs')!.id);
    await expect(exports.download(user, theirs)).rejects.toMatchObject({ status: 403 });
    await expect(exports.download(admin1, theirs)).resolves.toMatchObject({ size: 2050 });
    const old = String((await rows()).find((row) => row.report_name === 'Old')!.id);
    await expect(exports.download(user, old)).rejects.toMatchObject({ status: 409 });
    await expect(exports.download(user, '999999')).rejects.toMatchObject({ status: 404 });
    await admin!.query('UPDATE pos_user SET is_active=0 WHERE id=900001');
    await expect(exports.download(user, mine)).rejects.toMatchObject({ status: 401 });
  });
});
