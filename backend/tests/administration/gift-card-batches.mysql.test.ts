import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { registerGiftCardBatches } from '../../src/modules/gift-card-batches/index.js';
import {
  giftCardBatchWorker,
  type GiftCardBatchWorkerEvent,
} from '../../src/modules/gift-card-batches/worker.js';
import { readGiftCardBatchOptions } from '../../src/modules/gift-card-batches/options.js';
import { giftCardBatchHistory } from '../../src/modules/gift-card-batches/history.js';
import {
  giftCardBatchSearchInput,
  type GiftCardBatchStorage,
  type GiftCardBatchDeliveryOutcome,
} from '../../src/modules/gift-card-batches/contracts.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const template = process.env.GIFT_CARD_BATCH_MYSQL_TEST_URL;
describe.skipIf(!template)('gift card batches against isolated physical MySQL fixtures', () => {
  let connection: mysql.Connection, db: Databases, app: FastifyInstance, schema: string;
  let service: ReturnType<typeof registerGiftCardBatches>;
  let databaseUrl: string;
  let fixture: ReturnType<typeof verifiedMysqlFixture>;
  let now = Temporal.Instant.from('2026-11-16T10:00:00Z');
  let actor: Principal = {
    id: '1',
    name: 'Fixture Operator',
    email: 'owner@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
  const objects = new Map<string, Buffer>(),
    uploads: Buffer[] = [],
    sent: Buffer[] = [],
    events: GiftCardBatchWorkerEvent[] = [];
  let failStorage = false,
    deliveryOutcome: GiftCardBatchDeliveryOutcome = 'accepted';
  let onUpload: (() => Promise<void>) | undefined;
  let duringDelivery: ((signal?: AbortSignal) => Promise<GiftCardBatchDeliveryOutcome>) | undefined;
  const options = readGiftCardBatchOptions({
    GIFT_CARD_BATCHES_ENABLED: 'true',
    GIFT_CARD_BATCH_WORKER_ENABLED: 'true',
    GC_SALTKEY: 'synthetic-source-salt',
    GIFT_CARD_BATCH_ACTIVE_KEY_ID: 'fixture',
    GIFT_CARD_BATCH_ENCRYPTION_KEYS: JSON.stringify({ fixture: 'ab'.repeat(32) }),
    BQ_GIFT_CARD_BATCH_VIEW: 'test-project.pos.gift_card_batches',
    BQ_GIFT_CARD_BATCH_MATCH_UDF: 'test-project.pos.gift_card_batch_matches',
    BQ_GIFT_CARD_BATCH_CONTRACT: 'pos-gift-card-batch-history-v1',
  });
  const storage: GiftCardBatchStorage = {
    keyFor(id) {
      return `uploads/csv/giftcards/${id}.zip`;
    },
    async put(manifest, bytes, signal) {
      signal?.throwIfAborted();
      uploads.push(Buffer.from(bytes));
      await onUpload?.();
      if (failStorage) throw new Error('private-storage-canary@example.test');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.checksum);
      const previous = objects.get(manifest.key);
      if (previous) expect(previous).toEqual(bytes);
      objects.set(manifest.key, Buffer.from(bytes));
    },
    async get(manifest, signal) {
      signal?.throwIfAborted();
      const bytes = objects.get(manifest.key);
      if (!bytes) throw new Error('Missing fixture artifact');
      return Buffer.from(bytes);
    },
    close() {},
  };
  const command = () => ({ operationId: randomUUID(), size: 3, message: 'Fixture batch' });
  const worker = () => giftCardBatchWorker(service, (_level, event) => events.push(event));
  const details = (id: string) => service.details(actor, id);
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_gift_card_batches_test'
    )
      throw new Error(
        'Gift card native tests require the explicit isolated local schema template.',
      );
    schema = `pos_rewrite_gift_card_batches_test_${process.pid}_${randomUUID().slice(0, 8)}`;
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
    fixture = verifiedMysqlFixture(connection, [
      'evidence/mysql-gift-card-batches-schema.json',
      'evidence/mysql-global-benefits-schema.json',
    ]);
    await fixture.create([
      'pos_user',
      'gift_card_collection',
      'gift_vouchers',
      'pos_special_permission_activity_log',
    ]);
    for (const path of [
      'migrations/0006_operator_auth_epochs.sql',
      'src/modules/administration/migration.sql',
      'src/modules/gift-card-batches/migration.sql',
    ])
      for (const statement of readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
    url.pathname = '/' + schema;
    databaseUrl = url.href;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'synthetic-gift-card-batch-native-secret-'.repeat(2),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    db = createDatabases(config);
    app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      request.principal = actor;
    });
    app.setErrorHandler((error, _request, reply) =>
      error instanceof AppError
        ? reply.code(error.status).send({ error: { code: error.code } })
        : error instanceof ZodError
          ? reply.code(400).send({ error: { code: 'INVALID_REQUEST' } })
          : reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } }),
    );
    service = registerGiftCardBatches(app, config, db, options, {
      storage,
      clock: () => now,
      delivery: {
        async send(_attempt, input, signal) {
          signal?.throwIfAborted();
          expect(input.recipient).toBe('owner@example.test');
          sent.push(Buffer.from(input.archive));
          if (duringDelivery) return duringDelivery(signal);
          return deliveryOutcome;
        },
      },
    });
    await app.ready();
  });
  beforeEach(async () => {
    actor = {
      id: '1',
      name: 'Fixture Operator',
      email: 'owner@example.test',
      role: 1,
      userType: 1,
      storeIds: [],
    };
    now = Temporal.Instant.from('2026-11-16T10:00:00Z');
    failStorage = false;
    deliveryOutcome = 'accepted';
    onUpload = undefined;
    duringDelivery = undefined;
    objects.clear();
    uploads.length = 0;
    sent.length = 0;
    events.length = 0;
    for (const table of [
      'pos_rewrite_gift_card_batch_jobs',
      'pos_rewrite_gift_card_batch_mutations',
      'gift_card_collection',
      'gift_vouchers',
      'pos_special_permission_activity_log',
      'pos_rewrite_operator_auth_epochs',
      'pos_user',
    ])
      await connection.query('TRUNCATE TABLE ' + mysql.escapeId(table));
    await fixture.insert('pos_user', {
      id: '1',
      first_name: ' Owner ',
      last_name: ' Operator ',
      email: 'pos.owner@example.test',
      role: 1,
      user_type: 1,
      is_active: 1,
    });
    await fixture.insert('pos_user', {
      id: '2',
      first_name: 'Second',
      last_name: 'Operator',
      email: 'second@example.test',
      role: 2,
      user_type: 1,
      is_active: 1,
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (connection) {
      await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it('atomically queues once, preserves replay, and never creates funded vouchers', async () => {
    const input = command();
    const [first, second] = await Promise.all([
      service.create(actor, input),
      service.create(actor, input),
    ]);
    expect(first).toEqual(second);
    expect((await service.currentJobs(actor)).data.map((row) => row.id)).toEqual([first.batchId]);
    expect((await service.currentJobs({ ...actor, id: '2' })).data).toEqual([]);
    expect((await details(first.batchId)).job?.phase).toBe('QUEUED');
    expect(JSON.stringify(await details(first.batchId))).not.toMatch(
      /sealedSecrets|password|serial|pin|recipient/,
    );
    const [counts] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT (SELECT COUNT(*) FROM gift_card_collection) AS batches,(SELECT COUNT(*) FROM pos_rewrite_gift_card_batch_jobs) AS jobs,(SELECT COUNT(*) FROM gift_vouchers) AS vouchers',
    );
    expect(counts).toMatchObject([{ batches: '1', jobs: '1', vouchers: '0' }]);
    await expect(service.create(actor, { ...input, size: 4 })).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_OPERATION_REUSED',
    });
  });
  it('freezes one AES archive, stores privately, records provider acceptance and authorizes owner downloads', async () => {
    const created = await service.create(actor, command());
    expect(await worker().runOnce()).toBe(true);
    const batch = await details(created.batchId);
    expect(batch).toMatchObject({
      completed: true,
      printed: false,
      blocked: false,
      job: { phase: 'DELIVERED' },
      artifactAvailable: true,
      createdByName: 'Owner   Operator',
    });
    const access = await service.artifactAccess(actor, created.batchId);
    expect(access.password).toHaveLength(43);
    const archive = await service.archive(actor, created.batchId);
    expect(archive).toEqual(sent[0]);
    const zip = new ZipReader(new Uint8ArrayReader(archive), {
      password: access.password,
      useWebWorkers: false,
    });
    const entries = await zip.getEntries(),
      entry = entries[0];
    if (!entry || entry.directory) throw new Error('Fixture archive does not contain a file.');
    const csv = Buffer.from(await entry.getData(new Uint8ArrayWriter()));
    await zip.close();
    expect(csv.toString()).toMatch(/^Collection No,Serial No,Gift Card,Pin\r\n/);
    expect(csv.toString().trim().split('\r\n')).toHaveLength(4);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT artifact_bytes,sealed_secrets FROM pos_rewrite_gift_card_batch_jobs',
    );
    expect(rows[0]?.artifact_bytes).toBeNull();
    expect(String(rows[0]?.sealed_secrets)).not.toContain(access.password);
    expect(JSON.stringify(events)).not.toMatch(/owner@|GC[A-Z0-9]|password|private-/);
    const other = { ...actor, id: '2', role: 2 as const };
    await expect(service.artifactAccess(other, created.batchId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.archive(other, created.batchId)).rejects.toMatchObject({ status: 403 });
  });
  it('reuses frozen bytes after a storage failure and acknowledges exactly one delivery', async () => {
    const created = await service.create(actor, command());
    failStorage = true;
    await worker().runOnce();
    expect((await details(created.batchId)).job?.phase).toBe('GENERATED');
    expect(sent).toHaveLength(0);
    now = now.add({ seconds: 5 });
    failStorage = false;
    await worker().runOnce();
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toEqual(uploads[0]);
    expect(sent).toHaveLength(1);
    expect((await details(created.batchId)).job?.phase).toBe('DELIVERED');
  });
  it('fences concurrent supervised workers so only one archive and email are published', async () => {
    await service.create(actor, command());
    const results = await Promise.all([worker().runOnce(), worker().runOnce()]);
    expect(results.sort()).toEqual([false, true]);
    expect(uploads).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
  it('retains unresolved old work but sends completed history beyond24h out of the current recovery feed', async () => {
    const created = await service.create(actor, command());
    await worker().runOnce();
    await connection.query(
      "UPDATE pos_rewrite_gift_card_batch_jobs SET created_at='2026-11-14 09:00:00.000'",
    );
    expect((await service.currentJobs(actor)).data).toEqual([]);
    await connection.query("UPDATE pos_rewrite_gift_card_batch_jobs SET phase='UNCERTAIN'");
    expect((await service.currentJobs(actor)).data.map((row) => row.id)).toEqual([created.batchId]);
  });
  it('joins textual job IDs to the exact BIGINT collection without double-precision aliasing', async () => {
    for (const id of ['9007199254740992', '9007199254740993'])
      await fixture.insert('gift_card_collection', {
        id,
        size: 1,
        created_by: '1',
        created_at: '2026-11-16 12:00:00',
      });
    await connection.query(
      "INSERT INTO pos_rewrite_gift_card_batch_jobs (id,batch_id,actor_id,actor_version,requested_size,sealed_secrets,phase,artifact_key,attempts,created_at,updated_at) VALUES (?,'9007199254740993','1',?,1,'not-read-in-metadata','BLOCKED',?,0,'2026-11-16 10:00:00.000','2026-11-16 10:00:00.000')",
      [randomUUID(), 'f'.repeat(64), 'uploads/csv/giftcards/' + randomUUID() + '.zip'],
    );
    expect((await service.currentJobs(actor)).data.map((row) => row.id)).toEqual([
      '9007199254740993',
    ]);
  });
  it('bounds automatic storage retries and preserves frozen cards through explicit recovery', async () => {
    const created = await service.create(actor, command());
    failStorage = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      await worker().runOnce();
      now = now.add({ seconds: 65 });
    }
    const failed = await details(created.batchId);
    expect(failed.job?.phase).toBe('FAILED');
    expect(uploads).toHaveLength(5);
    for (const bytes of uploads) expect(bytes).toEqual(uploads[0]);
    expect(await worker().runOnce()).toBe(false);
    failStorage = false;
    await service.retry(actor, created.batchId, {
      operationId: randomUUID(),
      expectedVersion: failed.job!.version,
      confirmResend: false,
    });
    await worker().runOnce();
    expect(sent[0]).toEqual(uploads[0]);
  });
  it('never auto-resends uncertain delivery and requires an owner confirmation to send the same file', async () => {
    const created = await service.create(actor, command());
    deliveryOutcome = 'uncertain';
    await worker().runOnce();
    const batch = await details(created.batchId);
    expect(batch.job?.phase).toBe('UNCERTAIN');
    expect(batch.artifactAvailable).toBe(true);
    expect(await worker().runOnce()).toBe(false);
    expect(sent).toHaveLength(1);
    const retry = {
      operationId: randomUUID(),
      expectedVersion: batch.job!.version,
      confirmResend: false,
    };
    await expect(service.retry(actor, created.batchId, retry)).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_RESEND_CONFIRMATION',
    });
    const before = await service.artifactAccess(actor, created.batchId);
    await service.retry(actor, created.batchId, { ...retry, confirmResend: true });
    deliveryOutcome = 'accepted';
    await worker().runOnce();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(await service.artifactAccess(actor, created.batchId)).toEqual(before);
  });
  it('fences an expired sending lease as uncertain without sending again', async () => {
    const created = await service.create(actor, command());
    await connection.query(
      "UPDATE pos_rewrite_gift_card_batch_jobs SET phase='SENDING',lease_token=?,lease_expires_at='2026-11-16 09:59:59',delivery_attempt_id=?",
      [randomUUID(), randomUUID()],
    );
    expect(await worker().runOnce()).toBe(false);
    expect((await details(created.batchId)).job?.phase).toBe('UNCERTAIN');
    expect(sent).toHaveLength(0);
  });
  it('shuts down an in-flight delivery with a durable uncertain outcome and no automatic resend', async () => {
    const created = await service.create(actor, command());
    let announce: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    duringDelivery = async (signal) =>
      new Promise<GiftCardBatchDeliveryOutcome>((resolve) => {
        if (!signal) throw new Error('Fixture worker did not provide cancellation.');
        signal.addEventListener('abort', () => resolve('uncertain'), { once: true });
        announce();
      });
    const instance = worker(),
      pending = instance.runOnce();
    await started;
    await instance.stop();
    expect(await pending).toBe(true);
    expect((await details(created.batchId)).job?.phase).toBe('UNCERTAIN');
    expect(await worker().runOnce()).toBe(false);
    expect(sent).toHaveLength(1);
  });
  it('blocks changed owner credentials before publishing and permits explicit current-owner recovery', async () => {
    const created = await service.create(actor, command());
    await connection.query('UPDATE pos_user SET password=? WHERE id=1', ['changed-password-hash']);
    await worker().runOnce();
    expect(uploads).toHaveLength(0);
    const batch = await details(created.batchId);
    expect(batch.job?.phase).toBe('BLOCKED');
    await service.retry(actor, created.batchId, {
      operationId: randomUUID(),
      expectedVersion: batch.job!.version,
      confirmResend: false,
    });
    await worker().runOnce();
    expect(sent).toHaveLength(1);
  });
  it('rechecks owner authorization after storage I/O and withholds mail after archiving', async () => {
    const created = await service.create(actor, command());
    onUpload = async () => {
      await connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
    };
    await worker().runOnce();
    expect(sent).toHaveLength(0);
    const [jobs] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT phase FROM pos_rewrite_gift_card_batch_jobs',
    );
    expect(jobs[0]?.phase).toBe('BLOCKED');
    await expect(service.artifactAccess(actor, created.batchId)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('serializes mark-printed/block changes with stale revision rejection and exact idempotent receipts', async () => {
    const created = await service.create(actor, command());
    const incomplete = await details(created.batchId);
    await expect(
      service.markPrinted(actor, created.batchId, {
        operationId: randomUUID(),
        expectedVersion: incomplete.version,
        printed: true,
      }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_BATCH_INCOMPLETE' });
    await worker().runOnce();
    const ready = await details(created.batchId);
    const input = { operationId: randomUUID(), expectedVersion: ready.version, blocked: true };
    const receipt = await service.setBlocked(actor, created.batchId, input);
    expect(await service.setBlocked(actor, created.batchId, input)).toEqual(receipt);
    await expect(
      service.markPrinted(actor, created.batchId, {
        operationId: randomUUID(),
        expectedVersion: ready.version,
        printed: true,
      }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_BATCH_CHANGED' });
    const blocked = await details(created.batchId);
    await service.markPrinted(actor, created.batchId, {
      operationId: randomUUID(),
      expectedVersion: blocked.version,
      printed: true,
    });
    expect(await details(created.batchId)).toMatchObject({ printed: true, blocked: true });
  });
  it('rejects current franchise/revoked roles, unsupported encoding and legacy-unreadable new IDs without ghost rows', async () => {
    await connection.query('UPDATE pos_user SET user_type=2 WHERE id=1');
    await expect(service.create(actor, command())).rejects.toMatchObject({ status: 403 });
    await connection.query('UPDATE pos_user SET user_type=1,role=3 WHERE id=1');
    await expect(service.create(actor, command())).rejects.toMatchObject({ status: 403 });
    await connection.query('UPDATE pos_user SET role=1 WHERE id=1');
    await expect(
      service.create(actor, { ...command(), message: 'Unsupported🙂' }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_BATCH_MESSAGE_ENCODING' });
    await connection.query('ALTER TABLE gift_card_collection AUTO_INCREMENT=1000000000');
    await expect(service.create(actor, command())).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_FORMAT_UNSUPPORTED',
    });
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM gift_card_collection',
    );
    expect(rows[0]?.count).toBe('0');
  });
  it('uses the data reader only for today, pages in SQL and preserves literal wildcard searches', async () => {
    for (const row of [
      { id: '11', message: '100% ready' },
      { id: '12', message: '100X ready' },
      { id: '13', message: 'literal_under' },
    ])
      await fixture.insert('gift_card_collection', {
        ...row,
        size: 2,
        is_completed: 1,
        created_by: '1',
        created_at: '2026-11-16 12:00:00',
      });
    const input = giftCardBatchSearchInput.parse({
      from: '2026-11-16',
      to: '2026-11-16',
      search: '%',
      start: 99,
      length: 1,
    });
    const get = vi.spyOn(service.repository.db, 'get');
    const result = await service.history.search(actor, input);
    expect(result).toMatchObject({
      reader: 'data-reader',
      recordsTotal: '1',
      recordsFiltered: '1',
      start: 0,
      data: [{ id: '11', message: '100% ready' }],
    });
    expect(get.mock.calls.map((call) => call[0])).toContain('data');
    expect(get.mock.calls.map((call) => call[0])).not.toContain('primary');
    get.mockRestore();
  });
  it('matches pinned Django list sorting/paging/names with exact BIGINTs and records its broken legacy search', async () => {
    for (const [id, createdBy, message] of [
      ['11', '1', 'Alpha'],
      ['12', '2', 'Beta'],
      ['9007199254740993', '999', null],
    ] as const)
      await fixture.insert('gift_card_collection', {
        id,
        created_by: createdBy,
        message,
        size: 3,
        is_completed: 1,
        created_at: '2026-11-16 12:00:00',
      });
    const inputs = [
      { start: 0, length: 2 },
      { start: 1, length: 2 },
      { start: 999, length: 2 },
      { start: -2, length: 2 },
      { sort: 'size', direction: 'asc', length: 10 },
      { search: '%' },
    ];
    const oracle = z.object({ cases: z.array(z.unknown()) }).parse(
      JSON.parse(
        goldenStdout(
          'administration',
          'gift-card-batches-mysql',
          JSON.stringify({
            database: databaseUrl,
            cases: inputs.map((input) => ({ operation: 'list', ...input })),
          }),
          undefined,
          fixturePlaceholders(databaseUrl),
        ),
      ) as unknown,
    ).cases;
    for (const [index, input] of inputs.slice(0, -1).entries()) {
      const result = await service.history.search(
        actor,
        giftCardBatchSearchInput.parse({ from: '2026-11-16', to: '2026-11-16', ...input }),
      );
      const expected = z
        .object({
          recordsTotal: z.string(),
          recordsFiltered: z.string(),
          data: z.array(z.unknown()),
        })
        .parse(oracle[index]);
      expect({
        recordsTotal: result.recordsTotal,
        recordsFiltered: result.recordsFiltered,
        data: result.data.map((row) => ({
          id: row.id,
          size: row.size,
          message: row.message,
          is_completed: row.completed ? 1 : 0,
          is_printed: row.printed ? 1 : 0,
          is_block: row.blocked ? 1 : 0,
          created_by: row.createdByName || [],
          created_at: row.createdAt,
        })),
      }).toEqual(expected);
    }
    expect(oracle.at(-1)).toEqual({ error: 'FieldError' });
  }, 30000);
  it('routes all/historical ranges to bound BigQuery without a MySQL history fallback', async () => {
    const queryReport = vi.fn().mockResolvedValue([
      {
        total: '1',
        actual_start: '0',
        data: [
          {
            id: '20',
            size: '2',
            message: 'History',
            completed: 1,
            printed: 0,
            blocked: 0,
            createdById: '1',
            firstName: ' Owner ',
            lastName: ' Operator ',
            createdAt: '2026-11-15 12:00:00',
          },
        ],
      },
    ]);
    const history = giftCardBatchHistory(service, { queryReport });
    const get = vi.spyOn(service.repository.db, 'get');
    const result = await history.search(
      actor,
      giftCardBatchSearchInput.parse({ search: "literal%'_" }),
    );
    expect(result.reader).toBe('bigquery');
    expect(get.mock.calls.map((call) => call[0])).toEqual(['writer']);
    const [statement, params] = queryReport.mock.calls[0]!;
    expect(statement).not.toContain('literal%');
    expect(params).toMatchObject({ pattern: "%literal\\%'\\_%", fromTime: null, toTime: null });
    get.mockRestore();
    await history.search(
      actor,
      giftCardBatchSearchInput.parse({ from: '1000-01-01', to: '9999-12-31' }),
    );
    expect(queryReport.mock.calls[1]?.[1]).toMatchObject({
      fromTime: '1000-01-01 00:00:00',
      toTime: null,
    });
    queryReport.mockRejectedValueOnce(new Error('warehouse unavailable'));
    await expect(history.search(actor, giftCardBatchSearchInput.parse({}))).rejects.toThrow(
      'warehouse unavailable',
    );
    expect(queryReport).toHaveBeenCalledTimes(3);
  });
  it('rejects missing warehouse publication and inconsistent snapshots without falling back to MySQL reports', async () => {
    const queryReport = vi.fn().mockResolvedValue([{ total: '2', actual_start: '0', data: [] }]);
    const get = vi.spyOn(service.repository.db, 'get');
    const missing = giftCardBatchHistory(
      { ...service, options: { ...options, BQ_GIFT_CARD_BATCH_VIEW: undefined } },
      { queryReport },
    );
    await expect(missing.search(actor, giftCardBatchSearchInput.parse({}))).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_HISTORY_UNAVAILABLE',
    });
    expect(queryReport).not.toHaveBeenCalled();
    await expect(
      giftCardBatchHistory(service, { queryReport }).search(
        actor,
        giftCardBatchSearchInput.parse({}),
      ),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_BATCH_HISTORY_INVALID' });
    expect(get.mock.calls.map((call) => call[0])).toEqual(['writer', 'writer']);
    get.mockRestore();
  });
  it('retains the source initial-list audit once and strictly validates private HTTP resources', async () => {
    const viewOperationId = randomUUID();
    for (let index = 0; index < 2; index++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/gift-card-batches/search',
            payload: { from: '2026-11-16', to: '2026-11-16', viewOperationId },
          })
        ).statusCode,
      ).toBe(200);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT platform,comment,pos_user_id FROM pos_special_permission_activity_log',
    );
    expect(rows).toMatchObject([
      { platform: 'Gift Card', comment: 'Viewed the gift card batch list', pos_user_id: '1' },
    ]);
    expect(rows).toHaveLength(1);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/gift-card-batches',
      payload: command(),
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers['cache-control']).toBe('private, no-store');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/gift-card-batches/capabilities?email=private@example.test',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/gift-card-batches',
          payload: { ...command(), size: 10001 },
        })
      ).statusCode,
    ).toBe(400);
  });
});
