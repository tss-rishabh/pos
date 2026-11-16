import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/domain/access.js';
import { inventoryWorkbookFixture } from '../../tools/inventory-workbooks/fixture.js';
import { inventoryWorkbookBuilder } from '../../src/modules/inventory-workbooks/index.js';
import {
  reportExportService,
  type ExportBuilder,
} from '../../src/modules/operational-reports/export-service.js';
import {
  reportExportOptions,
  type ReportExportStore,
} from '../../src/modules/operational-reports/export-storage.js';
import {
  reportFileExtension,
  reportFileContentType,
} from '../../src/modules/operational-reports/export-format.js';
import type { ExportBuildContext } from '../../src/modules/operational-reports/export-artifact.js';

const connection = process.env.INVENTORY_WORKBOOK_MYSQL_TEST_URL;
describe.skipIf(!connection)(
  'inventory workbook through the existing durable export worker',
  () => {
    let fixture: Awaited<ReturnType<typeof inventoryWorkbookFixture>>,
      now = Temporal.Instant.from('2026-06-15T06:30:00Z'),
      builds = 0,
      puts = 0,
      heads = 0,
      lostPut = false;
    const actor: Principal = {
      id: '900001',
      name: 'Fixture',
      email: 'fixture@example.test',
      role: 4,
      userType: 1,
      storeIds: ['1', '2'],
    };
    const input = {
      kind: 'current-inventory-workbook',
      storeIds: ['2', '1'],
      label: 'Fixture workbook',
    } as const;
    const artifacts = new Map<string, { bytes: Buffer; checksum: string; contentType: string }>();
    async function consume(body: Readable) {
      const chunks: Buffer[] = [];
      for await (const value of body as AsyncIterable<unknown>) {
        if (!(value instanceof Uint8Array)) throw new Error('Unexpected fixture bytes.');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    }
    const store: ReportExportStore = {
      keyFor: (id, format = 'CSV') =>
        `uploads/reports/pos-rewrite/${id}.${reportFileExtension(format)}`,
      async put(id, bytes, checksum) {
        puts++;
        artifacts.set(this.keyFor(id), {
          bytes,
          checksum,
          contentType: reportFileContentType('CSV'),
        });
      },
      async putArtifact(id, file, format, signal) {
        puts++;
        const bytes = await consume(await file.open(signal));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.checksum);
        artifacts.set(this.keyFor(id, format), {
          bytes,
          checksum: file.checksum,
          contentType: reportFileContentType(format),
        });
        if (lostPut) throw new Error('Unknown synthetic upload response.');
      },
      async head(key) {
        heads++;
        const value = artifacts.get(key);
        return value
          ? { size: value.bytes.length, checksum: value.checksum, contentType: value.contentType }
          : null;
      },
      async stream(key, expected) {
        const value = artifacts.get(key);
        if (
          !value ||
          (expected &&
            (expected.size !== value.bytes.length || expected.checksum !== value.checksum))
        )
          throw new Error('Fixture checksum mismatch.');
        return {
          body: Readable.from([value.bytes]),
          size: value.bytes.length,
          contentType: value.contentType,
        };
      },
      close() {},
    };
    beforeAll(async () => {
      fixture = await inventoryWorkbookFixture(connection!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.product('101');
      await fixture.stock('101', '1', 3);
      await fixture.stock('101', '2', 9);
      now = Temporal.Instant.from('2026-06-15T06:30:00Z');
      builds = puts = heads = 0;
      lostPut = false;
      artifacts.clear();
    });
    afterAll(async () => fixture?.close());
    function service(builder?: ExportBuilder) {
      const native = inventoryWorkbookBuilder(fixture.config, fixture.db, fixture.options);
      const wrapped: ExportBuilder = async (user, value, context) => {
        builds++;
        return (builder || native)(user, value, context);
      };
      return reportExportService(
        fixture.config,
        fixture.db,
        reportExportOptions({}),
        store,
        wrapped,
        () => now,
        undefined,
        fixture.options,
      );
    }
    it('deduplicates concurrent ordered requests, streams one XLSX, records actual rows and downloads verified bytes', async () => {
      const exports = service(),
        command = randomUUID(),
        [first, replay] = await Promise.all([
          exports.create(actor, command, input, 'fixture-request'),
          exports.create(actor, command, input, 'retry-request'),
        ]);
      expect(first.id).toBe(replay.id);
      await expect(
        exports.create(actor, command, { ...input, storeIds: ['1', '2'] }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      const result = await Promise.all([exports.runOne(), exports.runOne()]);
      expect(result.filter(Boolean)).toHaveLength(1);
      expect(result.find(Boolean)).toMatchObject({ status: 'COMPLETED' });
      const receipt = await exports.read(actor, first.id);
      expect(receipt).toMatchObject({
        format: 'XLSX',
        from: null,
        to: null,
        rowCount: 2,
        canDownload: true,
      });
      expect(builds).toBe(1);
      expect(puts).toBe(1);
      const file = await exports.download(actor, first.id);
      expect(file.contentType).toBe(reportFileContentType('XLSX'));
      expect(file.filename).toBe(`inventory-${first.id}.xlsx`);
      expect((await consume(file.body)).subarray(0, 4)).toEqual(
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      );
      expect(await readdir(fixture.options.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
    });
    it('recovers an unknown streaming PUT with HEAD without rebuilding, resending or retaining local artifacts', async () => {
      lostPut = true;
      const exports = service(),
        job = await exports.create(actor, randomUUID(), input);
      expect(await exports.runOne()).toMatchObject({
        status: 'STORING',
        errorCode: 'UPLOAD_OUTCOME_UNKNOWN',
      });
      expect(await readdir(fixture.options.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
      now = now.add({ seconds: 16 });
      expect(await exports.runOne()).toMatchObject({ status: 'COMPLETED' });
      expect({ builds, puts, heads }).toEqual({ builds: 1, puts: 1, heads: 1 });
      expect((await exports.read(actor, job.id)).canDownload).toBe(true);
    });
    it('fails conflicting variants with a safe actionable SKU diagnostic and no partial upload', async () => {
      await fixture.fixture.insert('has_options', { prod_id: '101', attr_id: '1', attr_val: 'M' });
      await fixture.fixture.insert('has_options', { prod_id: '101', attr_id: '2', attr_val: 'm' });
      const exports = service(),
        job = await exports.create(actor, randomUUID(), input);
      expect(await exports.runOne()).toMatchObject({
        status: 'FAILED',
        errorCode: 'WORKBOOK_VARIANT_AMBIGUOUS:101',
      });
      const receipt = await exports.read(actor, job.id);
      expect(receipt.message).toContain('101');
      expect(JSON.stringify(receipt)).not.toContain('attr_val');
      expect(puts).toBe(0);
      expect(await readdir(fixture.options.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
    });
    it('rechecks writer-current franchise category and assignment before building and before download', async () => {
      await fixture.admin.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=900001');
      const user = { ...actor, role: 1 as const, userType: 2 as const },
        exports = service(),
        job = await exports.create(user, randomUUID(), input);
      await fixture.admin.query("UPDATE stores SET category='IN_HOUSE' WHERE id=2");
      expect(await exports.runOne()).toMatchObject({
        status: 'FAILED',
        errorCode: 'EXPORT_ACCESS_DENIED',
      });
      expect(builds).toBe(0);
      await fixture.admin.query("UPDATE stores SET category='FRANCHISE' WHERE id=2");
      const good = await exports.create(user, randomUUID(), input);
      expect(await exports.runOne()).toMatchObject({ status: 'COMPLETED' });
      await fixture.admin.query(
        'DELETE FROM user_stores WHERE django_user_id=900001 AND store_id=2',
      );
      await expect(exports.download(user, good.id)).rejects.toMatchObject({
        code: 'EXPORT_ACCESS_DENIED',
      });
      expect(job.id).not.toBe(good.id);
    });
    it('aborts a running build on worker shutdown and never publishes a partial workbook', async () => {
      let ready: (value: ExportBuildContext) => void = () => undefined;
      const started = new Promise<ExportBuildContext>((resolve) => {
        ready = resolve;
      });
      const exports = service(async (_user, _input, context) => {
        if (!context) throw new Error('Missing build context.');
        ready(context);
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        });
        throw new Error('Unexpected continuation.');
      });
      await exports.create(actor, randomUUID(), input);
      const run = exports.runOne(),
        context = await started;
      exports.abortBuilds();
      expect(context.signal.aborted).toBe(true);
      expect(await run).toMatchObject({ status: 'FAILED', errorCode: 'EXPORT_BUILD_FAILED' });
      expect(puts).toBe(0);
    });
    it('retains existing CSV bytes, default key extension, row count and response shape', async () => {
      const bytes = Buffer.from('"Store","Amount"\r\n"Fixture","-5.00"'),
        exports = service(async () => ({ bytes, rowCount: 1 })),
        job = await exports.create(actor, randomUUID(), {
          kind: 'cash-balance',
          from: '2026-06-15',
          to: '2026-06-15',
          storeIds: ['1'],
        });
      expect(await exports.runOne()).toMatchObject({ status: 'COMPLETED' });
      expect(await exports.read(actor, job.id)).toMatchObject({ format: 'CSV', rowCount: 1 });
      expect(await consume((await exports.download(actor, job.id)).body)).toEqual(bytes);
    });
    it('streams a fully validated legacy XLSX only for a current internal administrator', async () => {
      const exports = service(),
        job = await exports.create(actor, randomUUID(), input);
      await exports.runOne();
      const saved = artifacts.get(store.keyFor(job.id, 'XLSX'))!,
        key = 'uploads/reports/history/fixture.xlsx';
      artifacts.set(key, saved);
      await fixture.fixture.insert('report_exports', {
        id: '71',
        export_format: 'XLSX',
        export_file_url: key,
        is_completed: 1,
        export_requested_by: 900001,
      });
      await expect(exports.downloadLegacy(actor, '71')).rejects.toMatchObject({
        code: 'EXPORT_ACCESS_DENIED',
      });
      await fixture.admin.query('UPDATE pos_user SET role=1 WHERE id=900001');
      const file = await exports.downloadLegacy({ ...actor, role: 1 }, '71');
      expect(file.filename).toBe('legacy-report-71.xlsx');
      expect(await consume(file.body)).toEqual(saved.bytes);
      await expect
        .poll(() => readdir(fixture.options.INVENTORY_WORKBOOK_STAGING_DIRECTORY))
        .toEqual([]);
      artifacts.set(key, { ...saved, contentType: 'application/octet-stream' });
      await expect(exports.downloadLegacy({ ...actor, role: 1 }, '71')).rejects.toMatchObject({
        code: 'LEGACY_WORKBOOK_UNVERIFIED',
      });
    });
    it('renews a long-running build lease so another worker cannot fail or steal its live snapshot', async () => {
      let release: () => void = () => undefined,
        started: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        ready = new Promise<void>((resolve) => {
          started = resolve;
        }),
        native = inventoryWorkbookBuilder(fixture.config, fixture.db, fixture.options),
        exports = service(async (user, value, context) => {
          started();
          await gate;
          return native(user, value, context);
        });
      const job = await exports.create(actor, randomUUID(), input),
        run = exports.runOne();
      await ready;
      now = now.add({ seconds: 100 });
      try {
        await expect
          .poll(
            async () => {
              const [rows] = await fixture.admin.query<import('mysql2/promise').RowDataPacket[]>(
                'SELECT lease_until AS lease FROM pos_rewrite_report_exports WHERE id=?',
                [job.id],
              );
              return rows[0]?.lease;
            },
            { timeout: 12000, interval: 100 },
          )
          .toBe('2026-06-15 06:33:40.000');
        now = now.add({ seconds: 90 });
        expect(await service().runOne()).toBeNull();
      } finally {
        release();
      }
      expect(await run).toMatchObject({ status: 'COMPLETED' });
      expect(puts).toBe(1);
    }, 15000);
  },
);
