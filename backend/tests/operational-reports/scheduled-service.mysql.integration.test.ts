import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { scheduledReportOptions } from '../../src/modules/operational-reports/scheduled-options.js';
import {
  scheduledReportService,
  type ScheduledBuilder,
  type ScheduledSender,
} from '../../src/modules/operational-reports/scheduled-service.js';
const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('durable scheduled reports on isolated local MySQL', () => {
  const schema = `pos_rewrite_scheduled_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'scheduled-report-mysql-'.repeat(3),
    }),
    options = scheduledReportOptions({
      SLACK_URL: 'https://hooks.slack.com/services/FIXTURE/MAIN/SECRET',
      SLACK_DEMO_URL: 'https://hooks.slack.com/services/FIXTURE/DEMO/SECRET',
      SCHEDULED_REPORT_MAX_PENDING: '3',
    }),
    input = { kind: 'hyperlocal-delivery-delays' } as const;
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false,
    now = Temporal.Instant.from('2026-11-17T08:00:00Z'),
    builds = 0,
    failMain = false,
    onlyMain = false,
    failBuild = false;
  let sent: { target: string; id: string; text: string }[] = [];
  const builder: ScheduledBuilder = async () => {
      builds++;
      if (failBuild) throw new Error('private report data SQL secret');
      return {
        recordCount: 4,
        messages: [
          { target: 'main', text: 'Fixture private report body' },
          ...(onlyMain ? [] : [{ target: 'demo' as const, text: 'Fixture private report body' }]),
        ],
      };
    },
    sender: ScheduledSender = async (target, text, id) => {
      sent.push({ target, text, id });
      if (failMain && target === 'main')
        throw new Error('credential-bearing fixture URL not logged');
    };
  function db() {
    if (!databases) throw new Error('Fixture unavailable.');
    return databases;
  }
  const service = (overrides: Partial<typeof options> = {}) =>
    scheduledReportService(config, db(), { ...options, ...overrides }, builder, sender, () => now);
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Scheduled queue fixtures require local MySQL.');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await admin.changeUser({ database: schema });
    for (const query of readFileSync(
      'src/modules/operational-reports/scheduled-migration.sql',
      'utf8',
    )
      .split(';')
      .filter((value) => value.trim()))
      await admin.query(query);
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'scheduled-db-config-'.repeat(3),
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_WRITER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  beforeEach(async () => {
    for (const table of [
      'pos_rewrite_scheduled_report_targets',
      'pos_rewrite_scheduled_report_channels',
      'pos_rewrite_scheduled_reports',
    ])
      await admin!.query(`TRUNCATE TABLE ${mysql.escapeId(table)}`);
    now = Temporal.Instant.from('2026-11-17T08:00:00Z');
    builds = 0;
    sent = [];
    failMain = onlyMain = failBuild = false;
  });
  afterAll(async () => {
    await databases?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });
  it('deduplicates concurrent commands, bounds the queue and preserves original request tracing', async () => {
    const reports = service(),
      command = randomUUID(),
      [first, retry] = await Promise.all([
        reports.create(command, input, 'fixture-request'),
        reports.create(command, input, 'fixture-retry'),
      ]);
    expect(first.id).toBe(retry.id);
    await expect(
      reports.create(command, { kind: 'hyperlocal-cancellations' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const built = await reports.runOne();
    expect(built).toMatchObject({ jobId: first.id, status: 'READY', userId: 'service-reports' });
    expect(['fixture-request', 'fixture-retry']).toContain(built?.requestId);
    expect(builds).toBe(1);
    await Promise.all([reports.runOne(), reports.runOne()]);
    await reports.runOne();
    expect(sent.map((value) => value.target).sort()).toEqual(['demo', 'main']);
    expect(new Set(sent.map((value) => value.id)).size).toBe(2);
    expect((await reports.read(first.id)).status).toBe('DELIVERED');
    expect(JSON.stringify(await reports.read(first.id))).not.toContain('private report body');
    for (let index = 0; index < 3; index++) await reports.create(randomUUID(), input);
    await expect(reports.create(randomUUID(), input)).rejects.toMatchObject({
      code: 'SCHEDULED_REPORT_QUEUE_LIMIT',
    });
  });
  it('records uncertain target results without replay and reconciles each destination independently', async () => {
    failMain = true;
    const reports = service(),
      job = await reports.create(randomUUID(), input);
    await reports.runOne();
    expect(await reports.runOne()).toMatchObject({ status: 'DELIVERY_UNKNOWN' });
    await reports.runOne();
    now = now.add({ seconds: 10 });
    expect(await reports.runOne()).toBeNull();
    expect(sent.map((value) => value.target)).toEqual(['main', 'demo']);
    const receipt = await reports.read(job.id),
      uncertain = receipt.targets.find((target) => target.status === 'UNKNOWN')!,
      command = randomUUID();
    expect(receipt.targets.find((target) => target.target === 'demo')?.status).toBe('DELIVERED');
    expect(await reports.reconcile(job.id, uncertain.id, command, 'delivered')).toMatchObject({
      status: 'DELIVERED',
    });
    expect(await reports.reconcile(job.id, uncertain.id, command, 'delivered')).toMatchObject({
      status: 'DELIVERED',
    });
    await expect(
      reports.reconcile(job.id, uncertain.id, command, 'not-delivered'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(sent).toHaveLength(2);
  });
  it('requires explicit not-delivered reconciliation before an uncertain POST can be retried', async () => {
    onlyMain = failMain = true;
    const reports = service(),
      job = await reports.create(randomUUID(), input);
    await reports.runOne();
    await reports.runOne();
    const target = (await reports.read(job.id)).targets[0]!;
    now = now.add({ seconds: 2 });
    expect(await reports.runOne()).toBeNull();
    await reports.reconcile(job.id, target.id, randomUUID(), 'not-delivered');
    failMain = false;
    expect(await reports.runOne()).toMatchObject({ status: 'DELIVERED' });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.id).toBe(sent[1]?.id);
  });
  it('turns interrupted sends into uncertainty and interrupted builds into traceable failures', async () => {
    const reports = service(),
      job = await reports.create(randomUUID(), input);
    await reports.runOne();
    const target = (await reports.read(job.id)).targets[0]!;
    await admin!.query(
      "UPDATE pos_rewrite_scheduled_report_targets SET status='SENDING',claim_token=?,lease_until='2026-11-17 07:00:00' WHERE id=?",
      [randomUUID(), target.id],
    );
    expect(await reports.runOne()).toMatchObject({ status: 'DELIVERY_UNKNOWN', jobId: job.id });
    expect(sent).toHaveLength(0);
    const other = await reports.create(randomUUID(), input);
    await admin!.query(
      "UPDATE pos_rewrite_scheduled_reports SET status='BUILDING',lease_until='2026-11-17 07:00:00' WHERE id=?",
      [other.id],
    );
    await reports.runOne();
    expect(await reports.runOne()).toMatchObject({
      jobId: other.id,
      status: 'FAILED',
      errorCode: 'SCHEDULED_REPORT_BUILD_INTERRUPTED',
    });
    expect((await reports.read(other.id)).status).toBe('FAILED');
  });
  it('shares a destination throttle across workers and saves static build errors only', async () => {
    const reports = service({ SLACK_DEMO_URL: options.SLACK_URL }),
      job = await reports.create(randomUUID(), input);
    await reports.runOne();
    await Promise.all([reports.runOne(), reports.runOne()]);
    expect(sent).toHaveLength(1);
    now = now.add({ seconds: 1 });
    await reports.runOne();
    expect((await reports.read(job.id)).status).toBe('DELIVERED');
    failBuild = true;
    const other = await reports.create(randomUUID(), input);
    expect(await reports.runOne()).toMatchObject({
      jobId: other.id,
      status: 'FAILED',
      errorCode: 'SCHEDULED_REPORT_BUILD_FAILED',
    });
    expect(JSON.stringify(await reports.read(other.id))).not.toContain('secret');
  });
});
