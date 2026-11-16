import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import { AppError } from '../../src/domain/errors.js';
import { scheduledReportOptions } from '../../src/modules/operational-reports/scheduled-options.js';
import {
  scheduledReportService,
  scheduledMessageParts,
} from '../../src/modules/operational-reports/scheduled-service.js';
import { registerScheduledReportRoutes } from '../../src/modules/operational-reports/scheduled-routes.js';
import {
  scheduledReportWorker,
  type ScheduledWorkerEvent,
} from '../../src/modules/operational-reports/scheduled-worker.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});
describe('scheduled report service boundaries', () => {
  it('rejects absent/invalid/header-in-query credentials before DB work even with a valid browser principal', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'scheduled-api-fixture-'.repeat(3),
      }),
      options = scheduledReportOptions({ REPORTS_API_KEY: 'fixture-report-api-secret' });
    let calls = 0;
    const db: Databases = {
        get() {
          calls++;
          throw new Error('Forbidden DB read');
        },
        close: async () => {},
      },
      app = Fastify({ logger: false });
    apps.push(app);
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      request.principal = {
        id: '1',
        name: 'Fixture',
        email: 'fixture@example.test',
        role: 1,
        userType: 1,
        storeIds: [],
      };
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 400)
        .send({ code: error instanceof AppError ? error.code : 'INVALID_REQUEST' }),
    );
    await registerScheduledReportRoutes(app, scheduledReportService(config, db, options), options);
    const jobId = crypto.randomUUID(),
      targetId = crypto.randomUUID();
    for (const route of [
      {
        method: 'POST' as const,
        url: '/api/v1/report-deliveries',
        payload: { commandId: crypto.randomUUID(), input: { kind: 'hyperlocal-summary' } },
      },
      { method: 'GET' as const, url: `/api/v1/report-deliveries/${jobId}` },
      {
        method: 'POST' as const,
        url: `/api/v1/report-deliveries/${jobId}/targets/${targetId}/reconciliation`,
        payload: { commandId: crypto.randomUUID(), outcome: 'delivered' },
      },
    ])
      for (const headers of [
        {},
        { cookie: 'fixture-session' },
        { cookie: 'fixture-session', 'x-api-key': 'wrong' },
      ]) {
        const response = await app.inject({ ...route, headers });
        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain('fixture-report-api-secret');
      }
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/report-deliveries/${jobId}?x-api-key=fixture-report-api-secret`,
          headers: { cookie: 'fixture-session' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/report-deliveries',
          headers: { 'x-api-key': 'fixture-report-api-secret' },
          payload: { commandId: crypto.randomUUID(), input: { kind: 'unsupported' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(calls).toBe(0);
  });
  it('splits complete Unicode text below message limits and never logs payloads or raw worker errors', async () => {
    const text = 'Fixture\n' + String.fromCodePoint(0x1f600).repeat(70001),
      parts = scheduledMessageParts({ recordCount: 2, messages: [{ target: 'main', text }] }).parts;
    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(parts.every((part) => Array.from(part.text).length <= 35000)).toBe(true);
    const events: ScheduledWorkerEvent[] = [],
      worker = scheduledReportWorker(
        {
          async runOne() {
            throw new Error('private payload token');
          },
        },
        scheduledReportOptions({}),
        (_level, event) => events.push(event),
      );
    await Promise.all([worker.runOnce(), worker.runOnce()]);
    await worker.stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resource: 'scheduled-report-delivery',
      userId: 'service-reports',
      errorCode: 'SCHEDULED_REPORT_WORKER_FAILED',
    });
    expect(events[0]?.requestId).toBeTruthy();
    expect(events[0]?.eventInstanceId).toBeTruthy();
    expect(JSON.stringify(events)).not.toContain('private payload token');
  });
});
