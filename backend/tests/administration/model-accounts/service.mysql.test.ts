import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import Fastify from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../../src/domain/access.js';
import { AppError } from '../../../src/domain/errors.js';
import { verifyDjangoPassword } from '../../../src/auth/crypto.js';
import {
  operatorModelAccountService,
  registerOperatorModelAccounts,
} from '../../../src/modules/administration/model-accounts/index.js';
import { modelAccountInput } from '../../../src/modules/administration/model-accounts/domain.js';
import { storePublicUrl } from '../../../src/modules/administration/policies.js';
import { modelAccountFixture } from '../../../tools/administration/model-accounts/fixture.js';
import { goldenSpawnResult } from '../../golden/load.js';
import { memoryEphemeralStore, type EphemeralStore } from '../../../src/jobs/ephemeral.js';
import { fixturePlaceholders } from '../../golden/fixture-placeholders.js';
const connection = process.env.MODEL_ACCOUNTS_MYSQL_TEST_URL;
const actor: Principal = {
  id: '900001',
  name: 'Synthetic administrator',
  email: 'fixture@example.invalid',
  role: 1,
  userType: 1,
  storeIds: [],
};
const password = 'Z8y!p4Nq#23rLt5x';
const now = () => Temporal.Instant.from('2026-06-15T06:30:00Z');
const oracleSchema = z.object({
  addFields: z.array(z.string()),
  users: z.array(
    z.object({
      valid: z.boolean(),
      codes: z.record(z.string(), z.array(z.string())),
      account: z.record(z.string(), z.unknown()).optional(),
      passwordValid: z.boolean().optional(),
      saveError: z.string().optional(),
    }),
  ),
  stores: z.array(
    z.object({
      valid: z.boolean(),
      urlRequired: z.boolean(),
      codes: z.record(z.string(), z.array(z.string())),
      id: z.string().optional(),
      url: z.string().optional(),
      storeName: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      saveError: z.string().optional(),
    }),
  ),
  permissions: z.array(
    z.object({ add: z.boolean(), change: z.boolean(), sourceAllowed: z.boolean() }),
  ),
});
describe.skipIf(!connection)(
  'inherited model-only account defaults on isolated physical MySQL',
  () => {
    let fixture: Awaited<ReturnType<typeof modelAccountFixture>>,
      service: ReturnType<typeof operatorModelAccountService>,
      ephemeral: EphemeralStore;
    beforeAll(async () => {
      fixture = await modelAccountFixture(connection!);
    }, 20000);
    beforeEach(async () => {
      await fixture.reset();
      ephemeral = memoryEphemeralStore();
      service = operatorModelAccountService(fixture.config, fixture.db, now, ephemeral);
    });
    /** Replay receipts moved to Redis `pos:idem:admin_access:{operationId}` (ledger). */
    const receipts = async () =>
      Promise.all(
        (await ephemeral.scanKeys('pos:idem:admin_access:*')).map((key) => ephemeral.get(key)),
      );
    afterAll(async () => fixture?.close());
    const input = (username = 'model-fixture-user') => ({
      operationId: randomUUID(),
      username,
      password,
      confirmation: password,
    });
    async function count(table: string) {
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM ' + table,
      );
      return Number(rows[0]?.n);
    }
    async function oracle(
      users: { username: string; password: string; confirmation?: string }[] = [],
      storeUrls: string[] = [],
      extra: { minimalStore?: boolean } = {},
    ) {
      const result = goldenSpawnResult(
        'administration',
        'model-accounts-service-mysql',
        JSON.stringify({ database: fixture.url, users, storeUrls, ...extra }),
        undefined,
        fixturePlaceholders(fixture.url),
      );
      if (result.status !== 0)
        throw new Error('Model-add source oracle failed: ' + result.stdout.slice(0, 400));
      return oracleSchema.parse(JSON.parse(result.stdout) as unknown);
    }
    it('matches the actual pinned UserAdmin add fields and every persisted source default/null without creating commerce users', async () => {
      const source = await oracle([{ username: '  ｍｏｄｅｌ-fixture-user  ', password }]);
      expect(source.addFields).toEqual(['username', 'password1', 'password2']);
      expect(source.users[0]?.valid).toBe(true);
      await fixture.reset();
      const result = await service.create(actor, input('  ｍｏｄｅｌ-fixture-user  '));
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT * FROM pos_user WHERE id=?',
        [result.id],
      );
      const actual = { ...rows[0] };
      expect(await verifyDjangoPassword(password, String(actual.password))).toBe(true);
      delete actual.password;
      delete actual.id;
      actual.date_joined = String(actual.date_joined).replace(' ', 'T');
      for (const key of ['is_active', 'is_staff', 'is_superuser', 'is_mfa'])
        actual[key] = Boolean(actual[key]);
      const expected = { ...source.users[0]?.account };
      delete expected.id;
      expect(actual).toEqual(expected);
      expect(source.users[0]?.passwordValid).toBe(true);
      expect(await count('users')).toBe(0);
    }, 30000);
    it('proves required inherited Store url_key is overwritten by actual Store.save and existing generated policy already matches', async () => {
      const source = await oracle([], ['', 'arbitrary manual url', 'javascript:alert(1)']);
      expect(source.stores[0]).toMatchObject({
        valid: false,
        urlRequired: true,
        codes: { url_key: ['required'] },
      });
      for (const row of source.stores.slice(1)) {
        expect(row.valid).toBe(true);
        expect(row.url).toBe(storePublicUrl(row.id!));
        expect(row.storeName).toMatch(/^Synthetic store /);
        expect(row.phone).toMatch(/^900000000/);
      }
      const invalidPhysical = await oracle([], ['url-before-source-overwrite'], {
        minimalStore: true,
      });
      expect(invalidPhysical.stores[0]).toMatchObject({ valid: true, saveError: 'IntegrityError' });
    }, 30000);
    it('retains real source case-insensitive uniqueness/mismatched-password rejection and protects the login alias namespace', async () => {
      const source = await oracle([
        { username: 'Model-Pair', password },
        { username: 'model-pair', password },
        { username: 'Mismatch', password, confirmation: password + '!' },
      ]);
      expect(source.users.map((row) => row.valid)).toEqual([true, false, false]);
      expect(source.users[1]?.codes.username).toContain('unique');
      expect(source.users[2]?.codes.password2).toContain('password_mismatch');
      await fixture.reset();
      await service.create(actor, input('Model-Pair'));
      await expect(service.create(actor, input('model-pair'))).rejects.toMatchObject({
        code: 'OPERATOR_USERNAME_EXISTS',
      });
      await fixture.admin.query(
        "UPDATE pos_user SET email='login-alias@example.invalid' WHERE id=900002",
      );
      await expect(
        service.create(actor, input('login-alias@example.invalid')),
      ).rejects.toMatchObject({ code: 'OPERATOR_USERNAME_EXISTS' });
      expect(() => modelAccountInput.parse({ ...input(), confirmation: 'different' })).toThrow();
    }, 30000);
    it('preserves the actual blank-email default and converts its physical unique conflict into a recoverable setup error', async () => {
      const source = await oracle([
        { username: 'first-default', password },
        { username: 'second-default', password },
      ]);
      expect(source.users[0]?.account?.email).toBe('');
      expect(source.users[1]).toMatchObject({ valid: true, saveError: 'IntegrityError' });
      await fixture.reset();
      const first = await service.create(actor, input('first-default'));
      await expect(service.create(actor, input('second-default'))).rejects.toMatchObject({
        code: 'OPERATOR_MODEL_EMAIL_SETUP_REQUIRED',
      });
      expect(await count('pos_user')).toBe(8);
      await fixture.admin.query('UPDATE pos_user SET email=? WHERE id=?', [
        'completed@example.invalid',
        first.id,
      ]);
      const second = await service.create(actor, input('second-default'));
      expect(second.id).not.toBe(first.id);
    }, 30000);
    it('serializes distinct requests for the one source blank-email slot without partial accounts or unhandled physical conflicts', async () => {
      const results = await Promise.allSettled([
        service.create(actor, input('slot-one')),
        service.create({ ...actor, id: '900002' }, input('slot-two')),
      ]);
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((row) => row.status === 'rejected');
      expect(
        failed?.status === 'rejected' && failed.reason instanceof AppError && failed.reason.code,
      ).toBe('OPERATOR_MODEL_EMAIL_SETUP_REQUIRED');
      expect(await count('pos_user')).toBe(8);
      expect(await receipts()).toHaveLength(1);
    });
    it('creates and recovers one immutable original-UUID receipt under twenty concurrent requests without persisting raw credential/contact data', async () => {
      const value = input(),
        results = await Promise.all(Array.from({ length: 20 }, () => service.create(actor, value)));
      expect(new Set(results.map((row) => row.id)).size).toBe(1);
      expect(await receipts()).toHaveLength(1);
      expect(await count('pos_user')).toBe(8);
      expect(await service.read(actor, value.operationId)).toEqual(results[0]);
      const serialized = JSON.stringify(await receipts());
      expect(serialized).not.toContain(password);
      expect(serialized).not.toContain(value.username);
      expect(serialized).not.toContain('fixture@example');
      await expect(
        service.create(actor, { ...value, password: password + '!', confirmation: password + '!' }),
      ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_OPERATION_REUSED' });
      await expect(
        service.read({ ...actor, id: '900002' }, value.operationId),
      ).rejects.toMatchObject({ code: 'OPERATOR_MODEL_ACCOUNT_NOT_FOUND' });
    }, 20000);
    it('retains the source AND permission contract; with grants deleted only a current staff superuser may add', async () => {
      const source = await oracle();
      expect(source.permissions.map((row) => row.sourceAllowed)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      for (const id of ['900003', '900004', '900005', '900006', '900007'])
        await expect(
          service.create({ ...actor, id }, input('denied-' + id)),
        ).rejects.toBeInstanceOf(AppError);
      expect(await count('pos_user')).toBe(7);
      expect(await receipts()).toHaveLength(0);
      await expect(service.capabilities({ ...actor, id: '900003' })).rejects.toMatchObject({
        code: 'MODEL_ADMINISTRATION_DENIED',
      });
      expect(await service.capabilities(actor)).toMatchObject({ canCreate: true });
    }, 30000);
    it('keeps committed account replay independent of later target archival and refuses current actor privilege revocation', async () => {
      const value = input(),
        result = await service.create(actor, value);
      await fixture.admin.query('UPDATE pos_user SET is_active=0 WHERE id=?', [result.id]);
      expect(await service.create(actor, value)).toEqual(result);
      const [target] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT is_active FROM pos_user WHERE id=?',
        [result.id],
      );
      expect(target[0]?.is_active).toBe(0);
      await fixture.admin.query('UPDATE pos_user SET is_superuser=0 WHERE id=900001');
      await expect(service.read(actor, value.operationId)).rejects.toMatchObject({
        code: 'ADMIN_PRIVILEGE_MUTATION_DENIED',
      });
    });
    it('preserves generated IDs above2^53 and rejects old-password/common-password/additional privilege fields', async () => {
      await fixture.admin.query('ALTER TABLE pos_user AUTO_INCREMENT=9007199254740993');
      const result = await service.create(actor, input());
      expect(BigInt(result.id)).toBeGreaterThanOrEqual(9007199254740993n);
      await expect(
        service.create(actor, {
          ...input('short'),
          password: '12345678',
          confirmation: '12345678',
        }),
      ).rejects.toMatchObject({ code: 'PASSWORD_POLICY_REJECTED' });
      expect(() => modelAccountInput.parse({ ...input(), role: 2 })).toThrow();
      expect(() => modelAccountInput.parse({ ...input(), isSuperuser: true })).toThrow();
    });
    it('preserves source long-password behavior within the existing512-character login bound', async () => {
      const long = 'S9!mK_'.repeat(40),
        source = await oracle([{ username: 'long-model-account', password: long }]);
      expect(source.users[0]?.passwordValid).toBe(true);
      await fixture.reset();
      const result = await service.create(actor, {
        ...input('long-model-account'),
        password: long,
        confirmation: long,
      });
      const [rows] = await fixture.admin.query<RowDataPacket[]>(
        'SELECT password FROM pos_user WHERE id=?',
        [result.id],
      );
      expect(await verifyDjangoPassword(long, String(rows[0]?.password))).toBe(true);
    }, 30000);
    it('exposes only traced private strict create/capability/owner recovery resources', async () => {
      const app = Fastify(),
        traces: unknown[] = [];
      app.decorateRequest('principal', null);
      app.addHook('preHandler', async (request) => {
        request.principal = actor;
      });
      app.addHook('onRoute', (route) => {
        traces.push(route.config?.trace);
      });
      app.setErrorHandler((error, _req, reply) =>
        reply
          .code(error instanceof AppError ? error.status : 400)
          .send({ error: { code: error instanceof AppError ? error.code : 'INVALID_REQUEST' } }),
      );
      registerOperatorModelAccounts(app, fixture.config, fixture.db);
      try {
        const value = input(),
          reply = await app.inject({
            method: 'POST',
            url: '/api/v1/admin/operator-model-accounts',
            payload: value,
          });
        expect(reply.statusCode).toBe(200);
        expect(reply.headers['cache-control']).toBe('private, no-store');
        expect(reply.body).not.toContain(password);
        expect(reply.body).not.toContain('password');
        expect(
          (await app.inject('/api/v1/admin/operator-model-accounts/' + value.operationId)).body,
        ).toBe(reply.body);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/operator-model-accounts',
              payload: { ...input(), email: 'extra@example.invalid' },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          traces.every(
            (trace) =>
              !!trace &&
              typeof trace === 'object' &&
              'resource' in trace &&
              trace.resource === 'operator-model-account',
          ),
        ).toBe(true);
      } finally {
        await app.close();
      }
    });
  },
);
