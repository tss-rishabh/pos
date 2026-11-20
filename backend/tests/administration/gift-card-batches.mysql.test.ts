import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { ZipReader, Uint8ArrayReader, TextWriter } from '@zip.js/zip.js';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { recordingJobProducer } from '../../src/jobs/module-runtime.js';
import { giftCardBatchService } from '../../src/modules/gift-card-batches/service.js';
import { generateGiftCardBatch } from '../../src/modules/gift-card-batches/jobs.js';
import { readGiftCardBatchOptions } from '../../src/modules/gift-card-batches/options.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const template = process.env.GIFT_CARD_BATCH_MYSQL_TEST_URL;
/**
 * The pinned AjaxPrintGiftCardView / AjaxBlockGiftCardView / AjaxGenerateGiftCardView responses
 * (core/views.py), replayed from tests/golden/administration/gift-card-view.json with the exact
 * cases gift-card-view.test.ts sends. The rewrite answers are compared with them below.
 */
const legacyViewCase = z
  .object({
    response: z.object({ status: z.string(), message: z.string().optional() }).passthrough(),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();
function legacyGiftCardView(cases: unknown[]) {
  return z
    .object({ cases: z.array(legacyViewCase) })
    .parse(
      JSON.parse(
        goldenStdout('administration', 'gift-card-view', JSON.stringify({ cases })),
      ) as unknown,
    ).cases;
}
const legacyRows = [
  {
    id: 7,
    is_completed: 1,
    is_printed: 0,
    is_block: 0,
    size: 2,
    message: 'Fixture',
    filename: 'fixture.zip',
  },
];
const legacyFlags = legacyGiftCardView([
  { operation: 'print', rows: legacyRows, input: { collection: '7' } },
  { operation: 'block', rows: legacyRows, input: { collection: '7', opr: 'block' } },
  {
    operation: 'block',
    rows: [{ ...legacyRows[0]!, is_block: 1 }],
    input: { collection: '7', opr: 'active' },
  },
  { operation: 'print', rows: legacyRows, input: { collection: '999' } },
]);
const legacyGenerate = legacyGiftCardView([
  {
    operation: 'generate',
    input: { size: '2', message: 'Fixture' },
    email: 'pos.fixture@example.test',
  },
  { operation: 'generate', input: { size: '2', message: 'Fixture' }, email: '' },
  { operation: 'generate', input: { size: '-1', message: 'Fixture' } },
]);
/** Flag columns a legacy view case left on its collection row. */
const flags = (row: Record<string, unknown> | undefined) => ({
  is_printed: Number(row?.is_printed),
  is_block: Number(row?.is_block),
});
describe.skipIf(!template)('gift card batches against an isolated MySQL fixture', () => {
  let connection: mysql.Connection, db: Databases, schema: string, databaseUrl: string;
  let fixture: ReturnType<typeof verifiedMysqlFixture>;
  let jobs = recordingJobProducer(),
    ephemeral = memoryEphemeralStore();
  const now = Temporal.Instant.from('2026-11-16T10:00:00Z');
  const actor: Principal = {
    id: '1',
    name: 'Fixture Operator',
    email: 'owner@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
  const options = readGiftCardBatchOptions({
    GC_SALTKEY: 'synthetic-source-salt',
    AWS_STORAGE_BUCKET_NAME: 'private-pos-fixture',
    NETCORE_EMAIL_URL: 'https://mail.example.test/send',
    NETCORE_API_KEY: 'fixture-key',
  });
  const uploads: { key: string; bytes: Buffer }[] = [],
    sent: { collectionId: string; recipient: string; archive: Buffer }[] = [],
    logs: string[] = [];
  let failStorage = false,
    deliveryAccepts = true;
  let service: ReturnType<typeof giftCardBatchService>;
  const command = (size = 3) => ({ operationId: randomUUID(), size, message: 'Fixture batch' });
  const run = (args: { collectionId: string; size: number; userId: string }) =>
    generateGiftCardBatch(
      {
        db,
        options,
        storage: {
          async upload(key, bytes) {
            if (failStorage) throw new Error('storage');
            uploads.push({ key, bytes });
          },
          close() {},
        },
        delivery: {
          async send(input) {
            sent.push(input);
            return deliveryAccepts;
          },
        },
        log: (_level, event) => logs.push(String(event.eventId)),
        nowMicroseconds: () => 1731990000123456n,
        random: (min) => min,
      },
      args,
      { jobId: randomUUID(), requestId: null, userId: '1', signal: new AbortController().signal },
    );
  const collection = async (id: string) =>
    (
      await connection.query<mysql.RowDataPacket[]>(
        'SELECT size,message,is_completed,is_printed,is_block,filename,created_by FROM gift_card_collection WHERE id=?',
        [id],
      )
    )[0][0];
  beforeAll(async () => {
    const url = new URL(template!);
    if (url.protocol !== 'mysql:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Gift card native tests require an isolated local MySQL.');
    schema = `pos_gift_card_batches_test_${process.pid}_${randomUUID().slice(0, 8)}`;
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
    fixture = verifiedMysqlFixture(connection, ['evidence/mysql-gift-card-batches-schema.json']);
    await fixture.create([
      'pos_user',
      'gift_card_collection',
      'pos_special_permission_activity_log',
    ]);
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
    service = giftCardBatchService(config, db, options, {
      get jobs() {
        return jobs;
      },
      get ephemeral() {
        return ephemeral;
      },
      clock: () => now,
    });
  });
  beforeEach(async () => {
    jobs = recordingJobProducer();
    ephemeral = memoryEphemeralStore();
    uploads.length = 0;
    sent.length = 0;
    logs.length = 0;
    failStorage = false;
    deliveryAccepts = true;
    for (const table of ['gift_card_collection', 'pos_special_permission_activity_log', 'pos_user'])
      await connection.query('TRUNCATE TABLE ' + mysql.escapeId(table));
    await fixture.insert('pos_user', {
      id: '1',
      first_name: ' Owner ',
      last_name: ' Operator ',
      email: 'pos.owner@example.test',
      phone: '9876543210',
      role: 1,
      user_type: 1,
      is_active: 1,
    });
    await fixture.insert('pos_user', {
      id: '2',
      first_name: 'Franchise',
      last_name: 'Owner',
      email: 'franchise@example.test',
      role: 1,
      user_type: 2,
      is_active: 1,
    });
    await fixture.insert('pos_user', {
      id: '3',
      first_name: 'No',
      last_name: 'Mail',
      email: '',
      role: 2,
      user_type: 1,
      is_active: 1,
    });
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it('inserts the collection, enqueues ids only on queue core, and replays the receipt', async () => {
    const input = command();
    const first = await service.create(actor, input);
    expect(first.status).toBe('success');
    expect(await service.create(actor, input)).toEqual(first);
    await expect(service.create(actor, { ...input, size: 4 })).rejects.toMatchObject({
      code: 'GIFT_CARD_BATCH_OPERATION_REUSED',
    });
    expect(jobs.enqueued).toHaveLength(1);
    expect(jobs.enqueued[0]).toMatchObject({
      name: 'pos.gift_card_batches.generate',
      args: { collectionId: first.batchId, size: 3, userId: '1' },
      options: { queue: 'core' },
    });
    expect(JSON.stringify(jobs.enqueued[0]!.args)).not.toMatch(/@|98765/);
    expect(await collection(first.batchId)).toMatchObject({
      size: 3,
      message: 'Fixture batch',
      is_completed: 0,
      is_printed: 0,
      is_block: 0,
      filename: '',
      created_by: '1',
    });
    expect(await ephemeral.ttl(`pos:idem:gift_card_batch:${input.operationId}`)).toBe(86400);
  });
  it('generates, zips with the legacy derived password, uploads, emails and completes', async () => {
    const created = await service.create(actor, command());
    await run({ collectionId: created.batchId, size: 3, userId: '1' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.key).toBe('uploads/csv/giftcards/GFTCRDS-1731990000123456111111.zip');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      collectionId: created.batchId,
      recipient: 'owner@example.test',
    });
    const reader = new ZipReader(new Uint8ArrayReader(sent[0]!.archive), { useWebWorkers: false });
    const [entry] = await reader.getEntries();
    if (!entry || entry.directory || !entry.getData) throw new Error('missing entry');
    expect(entry.filename).toBe('GFTCRDS-1731990000123456111111.csv');
    const csv = await entry.getData(new TextWriter(), { password: '543210' + created.batchId });
    await reader.close();
    expect(csv.split('\r\n')[0]).toBe('Collection No,Serial No,Gift Card,Pin');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(4);
    expect(await collection(created.batchId)).toMatchObject({
      is_completed: 1,
      filename: 'uploads/csv/giftcards/GFTCRDS-1731990000123456111111.zip',
      message: 'Fixture batch| File has been sent on owner@example.test',
    });
    expect(logs).toEqual(['gift-card-batches.batch.generated']);
    await run({ collectionId: created.batchId, size: 3, userId: '1' });
    expect(sent).toHaveLength(1);
  });
  it('swallows storage and email failures as legacy does, but leaves failed generation incomplete', async () => {
    failStorage = true;
    deliveryAccepts = false;
    const created = await service.create(actor, command());
    await run({ collectionId: created.batchId, size: 3, userId: '1' });
    expect(await collection(created.batchId)).toMatchObject({ is_completed: 1 });
    expect(logs).toEqual([
      'gift-card-batches.batch.storage-failed',
      'gift-card-batches.batch.email-failed',
      'gift-card-batches.batch.generated',
    ]);
    const second = await service.create(actor, command());
    await generateGiftCardBatch(
      {
        db,
        options: {},
        storage: undefined,
        delivery: undefined,
        log: (_level, event) => logs.push(String(event.eventId)),
      },
      { collectionId: second.batchId, size: 3, userId: '1' },
      { jobId: randomUUID(), requestId: null, userId: '1', signal: new AbortController().signal },
    );
    expect(logs.at(-1)).toBe('gift-card-batches.batch.generation-failed');
    expect(await collection(second.batchId)).toMatchObject({ is_completed: 0, filename: '' });
  });
  it('creates the row then refuses requesters without email; franchise users are denied', async () => {
    // Legacy creates the collection, then answers `failed` with this message (gift-card-view
    // golden, case 2); the rewrite keeps the row and the text, with HTTP 422.
    expect(legacyGenerate[1]!.response).toMatchObject({ status: 'failed' });
    await expect(service.create({ ...actor, id: '3', role: 2 }, command())).rejects.toMatchObject({
      status: 422,
      code: 'GIFT_CARD_BATCH_NOT_ELIGIBLE',
      message: legacyGenerate[1]!.response.message,
    });
    expect(legacyGenerate[1]!.rows).toHaveLength(1);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT created_by,is_completed FROM gift_card_collection',
    );
    expect(rows).toEqual([{ created_by: '3', is_completed: 0 }]);
    expect(jobs.enqueued).toHaveLength(0);
    await expect(
      service.create({ ...actor, id: '2', userType: 2 }, command()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('marks printed and block/active exactly as legacy, and lists like the legacy datatable', async () => {
    const a = await service.create(actor, command(3)),
      b = await service.create(actor, command(5));
    // Messages and flag changes from the pinned views (gift-card-view golden).
    const [printed, blocked, activated, unknown] = legacyFlags;
    for (const legacy of [printed, blocked, activated])
      expect(legacy!.response.status).toBe('success');
    expect(await service.markPrinted(actor, a.batchId)).toMatchObject({
      message: printed!.response.message,
    });
    expect(flags(await collection(a.batchId))).toEqual(flags(printed!.rows[0]));
    expect(await collection(a.batchId)).toMatchObject({ is_completed: 0 });
    expect(await service.setBlocked(actor, b.batchId, { opr: 'block' })).toMatchObject({
      message: blocked!.response.message,
    });
    expect(flags(await collection(b.batchId))).toEqual(flags(blocked!.rows[0]));
    expect(await service.setBlocked(actor, b.batchId, { opr: 'active' })).toMatchObject({
      message: activated!.response.message,
    });
    expect(flags(await collection(b.batchId))).toEqual(flags(activated!.rows[0]));
    // Legacy: `failed` / "Please provide valid data" with the rows untouched; the rewrite answers
    // 404 GIFT_CARD_BATCH_NOT_FOUND (parity/administration-gift-card-batches.md:43).
    expect(unknown!.response).toMatchObject({ status: 'failed' });
    expect(unknown!.rows).toEqual(legacyRows);
    await expect(service.markPrinted(actor, '999')).rejects.toMatchObject({ status: 404 });
    const page = await service.list(actor, { draw: 1, start: 0, length: 10 });
    expect(page).toMatchObject({ draw: 1, recordsTotal: '2', recordsFiltered: '2', start: 0 });
    expect(page.data.map((row) => row.id)).toEqual([b.batchId, a.batchId]);
    expect(page.data[1]).toMatchObject({
      size: 3,
      printed: true,
      completed: false,
      blocked: false,
      createdBy: 'Owner   Operator',
      createdAt: '2026-11-16 15:30:00',
    });
    expect((await service.list(actor, { draw: 2, start: 30, length: 10 })).start).toBe(0);
    expect(
      (await service.list(actor, { draw: 3, sort: 'size', direction: 'asc' })).data.map(
        (row) => row.size,
      ),
    ).toEqual([3, 5]);
    const [logRows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT platform,comment FROM pos_special_permission_activity_log',
    );
    expect(logRows).toEqual([
      { platform: 'Gift Card', comment: 'Viewed the gift card batch list' },
    ]);
  });
  it('lists like the pinned Django datatable: sorting, paging, names and exact BIGINTs', async () => {
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
    ] as const;
    // Pinned AjaxGiftCardListView (core/datatables/gift_card_datatable.py, 78d5b63) on this
    // fixture, replayed from tests/golden/administration/gift-card-batches-mysql.json.
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
      const result = await service.list(actor, { draw: 1, ...input });
      const expected = z
        .object({
          draw: z.number(),
          recordsTotal: z.string(),
          recordsFiltered: z.string(),
          data: z.array(z.unknown()),
        })
        .parse(oracle[index]);
      expect(
        {
          draw: result.draw,
          recordsTotal: result.recordsTotal,
          recordsFiltered: result.recordsFiltered,
          data: result.data.map((row) => ({
            id: row.id,
            size: row.size,
            message: row.message,
            is_completed: row.completed ? 1 : 0,
            is_printed: row.printed ? 1 : 0,
            is_block: row.blocked ? 1 : 0,
            // Legacy renders a missing creator as an empty list; the rewrite sends ''.
            created_by: row.createdBy || [],
            created_at: row.createdAt,
          })),
        },
        JSON.stringify(input),
      ).toEqual(expected);
    }
    // Legacy search raises FieldError (no product relation); the rewrite keeps a working id
    // search (AGENTS.md administration decision, N7).
    expect(oracle.at(-1)).toEqual({ error: 'FieldError' });
    expect(
      (await service.list(actor, { draw: 2, search: '9007' })).data.map((row) => row.id),
    ).toEqual(['9007199254740993']);
  }, 30000);
});
