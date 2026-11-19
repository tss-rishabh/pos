import { registerRouteValidation } from '../../../src/domain/route-validation.js';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import Fastify from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../../src/domain/access.js';
import { AppError } from '../../../src/domain/errors.js';
import {
  barcodeAssignmentService,
  registerBarcodeAssignments,
} from '../../../src/modules/administration/barcodes/index.js';
import {
  barcodeMutationLockKey,
  withBarcodeMutationLock,
} from '../../../src/modules/administration/barcodes/locks.js';
import { memoryEphemeralStore } from '../../../src/jobs/ephemeral.js';
import {
  registerSecondaryCountrySearch,
  secondaryCountryService,
} from '../../../src/modules/administration/country-search.js';
import { administrationService } from '../../../src/modules/administration/service.js';
import { catalogService } from '../../../src/modules/catalog.js';
import { catalogMaintenanceService } from '../../../src/modules/catalog-details/maintenance-service.js';
import { barcodeFixture } from '../../../tools/administration/barcodes/fixture.js';
import { injectWriteFailure } from '../../helpers/production-schema.js';
import { goldenSpawnResult } from '../../golden/load.js';
import { fixturePlaceholders } from '../../golden/fixture-placeholders.js';

const connection = process.env.BARCODE_ASSIGNMENTS_MYSQL_TEST_URL;
const user: Principal = {
  id: '900001',
  name: 'Fixture operator',
  email: 'fixture@example.invalid',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
const now = Temporal.Instant.from('2026-06-15T06:30:00Z');
const sourceResponse = z.object({ status: z.enum(['success', 'fail']), message: z.string() });
const oracleSchema = z.object({
  barcodes: z.array(sourceResponse),
  countries: z.array(
    z.object({
      status: z.literal('success'),
      message: z.literal('Country name'),
      data: z.object({
        country: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
      }),
    }),
  ),
  audits: z.array(
    z.object({
      platform: z.string(),
      comment: z.string(),
      recipient: z.string(),
      pos_user_id: z.string(),
    }),
  ),
});
describe.skipIf(!connection)(
  'atomic barcode/country contracts on isolated physical-schema MySQL',
  () => {
    let fixture: Awaited<ReturnType<typeof barcodeFixture>>,
      service: ReturnType<typeof barcodeAssignmentService>,
      ephemeral: ReturnType<typeof memoryEphemeralStore>;
    beforeAll(async () => {
      fixture = await barcodeFixture(connection!);
    }, 20000);
    afterAll(async () => {
      await fixture?.close();
    });
    beforeEach(async () => {
      await fixture.reset();
      ephemeral = memoryEphemeralStore();
      service = barcodeAssignmentService(fixture.config, fixture.db, ephemeral, () => now);
    });
    async function receipts() {
      return String((await ephemeral.scanKeys('pos:idem:barcode:*')).length);
    }
    async function oracle(input: {
      barcodes?: { productId: string; barcode: string; operatorId?: string }[];
      countries?: (string | null)[];
    }) {
      const result = goldenSpawnResult(
        'administration',
        'barcodes-mysql',
        JSON.stringify({ database: fixture.url, ...input }),
        undefined,
        fixturePlaceholders(fixture.url),
      );
      if (result.status !== 0)
        throw new Error('Barcode/country source oracle failed: ' + result.stdout.slice(0, 300));
      return oracleSchema.parse(JSON.parse(result.stdout) as unknown);
    }
    async function count(table: 'products_gs1' | 'pos_special_permission_activity_log') {
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM ' + table,
      );
      return String(rows[0]?.count);
    }
    it('matches the actual pinned handler conflict priority, normalized messages and exact success activity', async () => {
      const seed = () => fixture.seed('products_gs1', { id: '20', product_id: '11', gtin: '123' });
      await seed();
      const cases = [
        { productId: '999', barcode: '123' },
        { productId: '11', barcode: '777' },
        { productId: '12', barcode: '123' },
        { productId: '_+0_1_3_', barcode: '0_0_5_5_5' },
        { productId: '14', barcode: '777' },
      ];
      const source = await oracle({ barcodes: cases });
      await fixture.reset();
      await seed();
      const actual = [];
      for (const input of cases)
        actual.push(await service.assign(user, { operationId: randomUUID(), ...input }));
      expect(actual.map(({ status, message }) => ({ status, message }))).toEqual(source.barcodes);
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT platform,comment,recipient,CAST(pos_user_id AS CHAR) AS pos_user_id FROM pos_special_permission_activity_log ORDER BY id',
      );
      expect(rows.map((row) => ({ ...row }))).toEqual(source.audits);
      expect(await receipts()).toBe('5');
    }, 30000);
    it('deduplicates twenty concurrent original-UUID submissions and does not duplicate barcode/activity on GET recovery', async () => {
      const input = { operationId: randomUUID(), productId: '11', barcode: '9999999999999' },
        results = await Promise.all(Array.from({ length: 20 }, () => service.assign(user, input)));
      expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
        true,
      );
      expect(await service.get(user, input.operationId)).toEqual(results[0]);
      expect(await count('products_gs1')).toBe('1');
      expect(await count('pos_special_permission_activity_log')).toBe('1');
      expect(await receipts()).toBe('1');
    });
    it('serializes distinct-product claims for the same GTIN and persists the losing source conflict exactly once', async () => {
      const results = await Promise.all([
        service.assign(user, { operationId: randomUUID(), productId: '11', barcode: '444' }),
        service.assign(
          { ...user, id: '900002', role: 2 },
          { operationId: randomUUID(), productId: '12', barcode: '444' },
        ),
      ]);
      expect(results.map((result) => result.code).sort()).toEqual(['ASSIGNED', 'GTIN_ASSIGNED']);
      expect(await count('products_gs1')).toBe('1');
      expect(await count('pos_special_permission_activity_log')).toBe('1');
      expect(await receipts()).toBe('2');
    });
    it('serializes same-product claims with different GTINs without inventing legacy UNIQUE constraints', async () => {
      const results = await Promise.all([
        service.assign(user, { operationId: randomUUID(), productId: '11', barcode: '445' }),
        service.assign(
          { ...user, id: '900003', role: 3 },
          { operationId: randomUUID(), productId: '11', barcode: '446' },
        ),
      ]);
      expect(results.map((result) => result.code).sort()).toEqual([
        'ASSIGNED',
        'PRODUCT_HAS_BARCODE',
      ]);
      expect(await count('products_gs1')).toBe('1');
    });
    it('waits on the Redis barcode mutation lease without partially creating a barcode or audit', async () => {
      let acquired!: () => void,
        release!: () => void,
        finished = false;
      const locked = new Promise<void>((resolve) => {
          acquired = resolve;
        }),
        wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      const blocker = withBarcodeMutationLock(ephemeral, async () => {
        expect(await ephemeral.get(barcodeMutationLockKey)).not.toBeNull();
        acquired();
        await wait;
      });
      await locked;
      const operation = service
        .assign(user, { operationId: randomUUID(), productId: '11', barcode: '448' })
        .then((result) => {
          finished = true;
          return result;
        });
      try {
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(finished).toBe(false);
        expect(await count('products_gs1')).toBe('0');
        expect(await count('pos_special_permission_activity_log')).toBe('0');
      } finally {
        release();
      }
      await blocker;
      expect((await operation).status).toBe('success');
    });
    // W8d: troubleshooting now runs synchronously under the Redis lock
    // pos:lock:catalog:barcode-mutations and rewrites duplicates to <gtin>0123 unconditionally, as
    // legacy core/views.py:3016-3020 does. Barcode assignment (W8b) takes the same Redis lock;
    // the sequential outcome is asserted.
    it('refuses a new assignment of the temporary GTIN written by product troubleshooting', async () => {
      await fixture.seed('products_gs1', { id: '101', product_id: '11', gtin: '123' });
      await fixture.seed('products_gs1', { id: '102', product_id: '12', gtin: '123' });
      const temporary = '1230123';
      let sends = 0;
      const repair = catalogMaintenanceService(
        fixture.db,
        {
          products: async () => {
            sends++;
          },
        },
        memoryEphemeralStore(),
      );
      expect((await repair.troubleshoot(user, '11', 'fixture-barcode-repair')).status).toBe(200);
      const assigned = await service.assign(
        { ...user, id: '900002', role: 2 },
        { operationId: randomUUID(), productId: '13', barcode: temporary },
      );
      expect(assigned.code).toBe('GTIN_ASSIGNED');
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM products_gs1 WHERE gtin=?',
        [temporary],
      );
      expect(String(rows[0]?.count)).toBe('1');
      expect(sends).toBe(1);
    });

    it('keeps the barcode when the activity insert fails, as the source logger swallows its error', async () => {
      // Test-only fault injection on the disposable schema: a SIGNAL trigger fails the audit insert.
      const restore = await injectWriteFailure(fixture.admin, {
        table: 'pos_special_permission_activity_log',
        event: 'INSERT',
        message: 'Synthetic audit failure',
      });
      const input = { operationId: randomUUID(), productId: '11', barcode: '449' };
      let result: Awaited<ReturnType<typeof service.assign>>;
      try {
        result = await service.assign(user, input);
        expect(result).toMatchObject({ status: 'success', auditId: null });
        expect(await count('products_gs1')).toBe('1');
        expect(await count('pos_special_permission_activity_log')).toBe('0');
      } finally {
        await restore();
      }
      expect(await service.assign(user, input)).toEqual(result);
    });
    it('keeps rejected receipts immutable and rejects UUID reuse with different canonical input or another actor', async () => {
      const input = { operationId: randomUUID(), productId: '999', barcode: '451' },
        original = await service.assign(user, input);
      await fixture.seed('products', { id: '999', product: 'Later product' });
      expect(await service.assign(user, input)).toEqual(original);
      await expect(service.assign(user, { ...input, barcode: '452' })).rejects.toMatchObject({
        status: 409,
        code: 'BARCODE_OPERATION_REUSED',
      });
      await expect(service.assign({ ...user, id: '900002', role: 2 }, input)).rejects.toMatchObject(
        { status: 409 },
      );
      await expect(
        service.get({ ...user, id: '900002', role: 2 }, input.operationId),
      ).rejects.toMatchObject({ status: 404 });
      expect((await service.assign(user, { ...input, operationId: randomUUID() })).status).toBe(
        'success',
      );
    });
    it('uses current writer account roles/type/status for both write and recovery, independent of browser claims', async () => {
      const input = { operationId: randomUUID(), productId: '11', barcode: '453' };
      await service.assign(user, input);
      for (const [id, status] of [
        ['900004', 403],
        ['900006', 401],
      ] as const) {
        const principal = { ...user, id };
        await expect(
          service.assign(principal, { ...input, operationId: randomUUID() }),
        ).rejects.toMatchObject({ status });
        await expect(service.get(principal, input.operationId)).rejects.toMatchObject({ status });
      }
      // Source `advance_permisson("[1,2,3]")` admits franchise (user_type 2) roles 1-3 too.
      expect(
        (await service.assign({ ...user, id: '900005' }, { ...input, operationId: randomUUID() }))
          .code,
      ).toBe('PRODUCT_HAS_BARCODE');
      await fixture.admin.query('UPDATE pos_user SET role=4 WHERE id=900001');
      await expect(service.get(user, input.operationId)).rejects.toMatchObject({ status: 403 });
      expect(await count('products_gs1')).toBe('1');
    });
    it('retains full-width product/GTIN/generated IDs without $returningId or numeric rounding', async () => {
      // Test-only on the disposable schema: bump AUTO_INCREMENT past 2^53 to prove lossless IDs.
      await fixture.admin.query('ALTER TABLE products_gs1 AUTO_INCREMENT=9007199254740993');
      await fixture.admin.query(
        'ALTER TABLE pos_special_permission_activity_log AUTO_INCREMENT=9007199254740993',
      );
      const result = await service.assign(user, {
        operationId: randomUUID(),
        productId: '9007199254740993',
        barcode: '9007199254740995',
      });
      expect(result).toMatchObject({
        productId: '9007199254740993',
        barcode: '9007199254740995',
        barcodeRowId: '9007199254740993',
        auditId: '9007199254740993',
      });
      expect(await service.get(user, result.id)).toEqual(result);
    });
    it('distinguishes adjacent large GTINs in real indexed lookups without coercing them through floating point', async () => {
      await fixture.seed('products_gs1', { product_id: '11', gtin: '9007199254740994' });
      expect(
        (
          await service.assign(user, {
            operationId: randomUUID(),
            productId: '12',
            barcode: '9007199254740995',
          })
        ).code,
      ).toBe('ASSIGNED');
      expect(
        (
          await service.assign(user, {
            operationId: randomUUID(),
            productId: '13',
            barcode: '9007199254740994',
          })
        ).message,
      ).toBe('Barcode already belongs to another product, Product ID : 11');
      expect(
        (
          await service.assign(user, {
            operationId: randomUUID(),
            productId: '14',
            barcode: '9223372036854775807',
          })
        ).code,
      ).toBe('ASSIGNED');
      expect(
        (
          await service.assign(user, {
            operationId: randomUUID(),
            productId: '15',
            barcode: '9223372036854775806',
          })
        ).code,
      ).toBe('ASSIGNED');
    });

    it('keeps existing malformed/zero barcode rows as source conflicts instead of silently replacing them', async () => {
      await fixture.seed('products_gs1', { product_id: '11', gtin: 0 });
      const existing = await service.assign(user, {
        operationId: randomUUID(),
        productId: '11',
        barcode: '455',
      });
      expect(existing.message).toBe('Product already belongs to another Barcode');
      await fixture.seed('products_gs1', { product_id: '999', gtin: '456' });
      const orphan = await service.assign(user, {
        operationId: randomUUID(),
        productId: '12',
        barcode: '456',
      });
      expect(orphan).toMatchObject({ status: 'fail', code: 'GTIN_ASSIGNED' });
      expect(await count('pos_special_permission_activity_log')).toBe('0');
    });
    it('matches pinned secondary-country collation, literal wildcards, source empty/whitespace and independent status profiles', async () => {
      const countries = [
        ['1', 'India', 1, 1],
        ['2', 'Indonesia', 1, 0],
        ['3', 'Inactive India', 0, 1],
        ['4', "Côte d'Ivoire", 1, 1],
        ['5', 'Percent % land', 1, 1],
        ['6', 'Under_score', 1, 1],
        ['7', 'Back\\slash', 1, 1],
        ['8', 'Hidden', 0, 0],
      ] as const;
      for (const [id, name, status, secondary] of countries)
        await fixture.seed('countries', { id, name, status, sec_status: secondary });
      const searches = [null, '', 'in', 'INDIA', 'cote', '%', '_', '\\', "'", ' ', ' none '],
        source = await oracle({ countries: searches }),
        lookup = secondaryCountryService(fixture.db),
        readers: string[] = [],
        routed = {
          ...fixture.db,
          get: (name: Parameters<typeof fixture.db.get>[0]) => {
            readers.push(name);
            return fixture.db.get(name);
          },
        };
      const actual = [];
      for (const search of searches)
        actual.push(
          await lookup.search(
            { ...user, id: '900005', userType: 2 },
            { ...(search === null ? {} : { search }) },
          ),
        );
      expect(actual).toEqual(source.countries);
      const sourceSecondary = await secondaryCountryService(routed).search(user, {
        search: 'India',
      });
      expect(sourceSecondary.data.country?.map((row) => row.id)).toEqual(['1', '3']);
      expect(readers).toEqual(['writer', 'primary', 'writer']);
      const standard = await administrationService(fixture.config, fixture.db).countries(user);
      expect(standard.map((row) => String(row.id))).toContain('2');
      expect(standard.map((row) => String(row.id))).not.toContain('3');
    }, 30000);
    it('restricts the main catalog store picker for every franchise role while preserving internal role1 global scope', async () => {
      const catalog = catalogService(fixture.db);
      for (const role of [1, 2, 3, 4, 5] as const) {
        expect(
          (await catalog.stores({ ...user, role, userType: 2, storeIds: ['1', '2', '4'] })).map(
            (row) => row.id,
          ),
        ).toEqual(['1']);
        expect(await catalog.stores({ ...user, role, userType: 2, storeIds: [] })).toEqual([]);
        expect((await catalog.stores({ ...user, role, userType: 1 })).map((row) => row.id)).toEqual(
          role === 1 ? ['1', '2', '3'] : ['1', '2'],
        );
      }
      expect((await catalog.stores(user))[0]).toEqual({
        id: '1',
        name: 'Store 1',
        locationCode: '',
        city: '',
        active: true,
      });
    });
    it('serves traced private POST search/assignment and GET-only recovery with strict body/query and current auth', async () => {
      const app = Fastify({ logger: false }),
        traces: unknown[] = [];
      app.decorateRequest('principal', null);
      registerRouteValidation(app);
      app.addHook('onRoute', (route) => {
        traces.push(route.config?.trace);
      });
      app.addHook('onRequest', async (request) => {
        if (request.headers['x-fixture-auth'] === 'yes') request.principal = user;
      });
      app.setErrorHandler((error, _request, reply) => {
        void reply
          .code(error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500)
          .send({
            error: {
              code: error instanceof AppError ? error.code : 'INVALID_REQUEST',
              message: 'Fixture request failed.',
            },
          });
      });
      registerBarcodeAssignments(app, fixture.config, fixture.db, ephemeral);
      registerSecondaryCountrySearch(app, fixture.db);
      try {
        const input = { operationId: randomUUID(), productId: '11', barcode: '459' },
          created = await app.inject({
            method: 'POST',
            url: '/api/v1/admin/barcode-assignments',
            headers: { 'x-fixture-auth': 'yes' },
            payload: input,
          });
        expect(created.statusCode).toBe(200);
        expect(created.headers['cache-control']).toBe('private, no-store');
        expect(created.json()).toMatchObject({
          status: 'success',
          message: 'Barcode 459 has been added for product Id 11',
        });
        expect(
          (
            await app.inject({
              url: '/api/v1/admin/barcode-assignments/' + input.operationId,
              headers: { 'x-fixture-auth': 'yes' },
            })
          ).json(),
        ).toEqual(created.json());
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/barcode-assignments',
              headers: { 'x-fixture-auth': 'yes' },
              payload: { ...input, productId: 11 },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/countries/secondary/search',
              headers: { 'x-fixture-auth': 'yes' },
              payload: {},
            })
          ).json(),
        ).toEqual({ status: 'success', message: 'Country name', data: {} });
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/countries/secondary/search?q=India',
              headers: { 'x-fixture-auth': 'yes' },
              payload: {},
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/barcode-assignments',
              payload: input,
            })
          ).statusCode,
        ).toBe(401);
        expect(traces).toHaveLength(4);
        expect(
          traces.every(
            (trace) =>
              z
                .object({
                  module: z.literal('administration'),
                  resource: z.enum(['barcode-assignment', 'secondary-country']),
                  action: z.string(),
                })
                .safeParse(trace).success,
          ),
        ).toBe(true);
      } finally {
        await app.close();
      }
    });
  },
);
