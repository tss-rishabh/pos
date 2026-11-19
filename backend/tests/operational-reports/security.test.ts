import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { registerOperationalReports } from '../../src/modules/operational-reports/index.js';
import { recordingJobProducer } from '../../src/jobs/module-runtime.js';
const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'operational-security-fixture-'.repeat(3),
  }),
  user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 2,
    storeIds: ['1'],
  };
const apps: ReturnType<typeof Fastify>[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});
describe('operational report request boundaries', () => {
  it('rejects privilege changes, raw injected email and operator/store/role violations before DB work', async () => {
    let calls = 0;
    const db: Databases = {
        get: () => {
          calls++;
          throw new Error('Unexpected DB work');
        },
        close: async () => {},
      },
      app = Fastify({ logger: false });
    apps.push(app);
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      if (request.headers.cookie === 'fixture-session') request.principal = user;
      else if (request.headers.cookie === 'fixture-staff') request.principal = { ...user, role: 5 };
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 400)
        .send({ code: error instanceof AppError ? error.code : 'INVALID_REQUEST' }),
    );
    await registerOperationalReports(app, config, db, { jobs: recordingJobProducer() });
    const orderInput = { from: '2026-11-16T00:00:00', to: '2026-11-16T23:59:59', storeIds: ['1'] };
    for (const input of [
      { ...orderInput, userType: 1 },
      { ...orderInput, source: 'online;DROP TABLE orders' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/reports/order-transactions/search',
            headers: { cookie: 'fixture-session' },
            payload: input,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/reports/order-transactions/search',
          headers: { cookie: 'fixture-session' },
          payload: { ...orderInput, storeIds: ['2'] },
        })
      ).statusCode,
    ).toBe(403);
    for (const resource of ['salesperson-performance', 'cashier-performance'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/reports/${resource}/search`,
            headers: { cookie: 'fixture-session' },
            payload: { from: '2026-11-16T00:00:00', to: '2026-11-16T23:59:59', storeIds: ['1'] },
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/reports/hyperlocal-acceptance/search',
          headers: { cookie: 'fixture-session' },
          payload: { from: '2026-11-16T00:00:00', to: '2026-11-16T23:59:59', storeIds: ['1'] },
        })
      ).statusCode,
    ).toBe(403);
    for (const payload of [
      {
        commandId: 'not-a-command',
        input: { kind: 'cash-balance', from: '2026-11-16', to: '2026-11-16' },
      },
      {
        commandId: crypto.randomUUID(),
        input: { kind: 'cash-balance', from: '2026-11-16', to: '2026-11-16', userType: 1 },
      },
      {
        commandId: crypto.randomUUID(),
        input: { kind: 'cash-balance', from: '2026-11-16', to: '2026-11-15' },
      },
      {
        commandId: crypto.randomUUID(),
        input: { kind: 'cash-balance', from: '2026-13-16', to: '2026-13-16' },
      },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/report-exports',
            headers: { cookie: 'fixture-session', 'x-operator-id': user.id },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/report-exports',
          headers: { cookie: 'fixture-session', 'x-operator-id': '11' },
          payload: { input: { kind: 'cash-balance', from: '2026-11-16', to: '2026-11-16' } },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/report-exports/1/file' })).statusCode,
    ).toBe(401);
    const body = { from: '2026-11-16T00:00:00', to: '2026-11-16T23:59:59', storeIds: ['1'] };
    for (const payload of [
      { ...body, userType: 1 },
      { ...body, email: "x@example.test' OR 1=1 --" },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/reports/customer-feedback/search',
            headers: { cookie: 'fixture-session' },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/stores/1/inventory/parent-associations',
          headers: { cookie: 'fixture-session', 'x-operator-id': '11' },
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/stores/2/inventory/parent-associations',
          headers: { cookie: 'fixture-session', 'x-operator-id': '10' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/stores/1/inventory/parent-associations',
          headers: { cookie: 'fixture-staff', 'x-operator-id': '10' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toBe(0);
  });
});
