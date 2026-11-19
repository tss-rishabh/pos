import Fastify from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { AppError } from '../../src/domain/errors.js';
import { scheduledReportOptions } from '../../src/modules/operational-reports/scheduled-options.js';
import {
  registerScheduledReportRoutes,
  scheduledReportRunner,
  type ScheduledBuilder,
} from '../../src/modules/operational-reports/scheduled-routes.js';
import { slackWebhookAllowed } from '../../src/modules/operational-reports/slack.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});
const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'scheduled-api-fixture-'.repeat(3),
  }),
  options = scheduledReportOptions({
    REPORTS_API_KEY: 'fixture-report-api-secret',
    SLACK_URL: 'https://hooks.slack.com/services/FIXTURE/MAIN/SECRET',
    SLACK_DEMO_URL: 'https://hooks.slack.com/services/FIXTURE/DEMO/SECRET',
  }),
  now = () => Temporal.Instant.from('2026-11-17T08:00:00Z');
function fixture(builder: ScheduledBuilder) {
  const posts: { url: string | undefined; text: string }[] = [],
    run = scheduledReportRunner(
      config,
      options,
      builder,
      async (url, text) => {
        posts.push({ url, text });
        return true;
      },
      now,
    ),
    app = Fastify({ logger: false });
  apps.push(app);
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof AppError ? error.status : 400)
      .send({ code: error instanceof AppError ? error.code : 'INVALID_REQUEST' }),
  );
  return { app, posts, run };
}
describe('scheduled Slack reports run inline (legacy report/views.py:810-1876)', () => {
  it('rejects absent, wrong or query-supplied API keys before building the report', async () => {
    let builds = 0;
    const { app, run } = fixture(async () => {
      builds++;
      return { recordCount: 0, messages: [] };
    });
    await registerScheduledReportRoutes(app, run, options);
    for (const headers of [
      {},
      { cookie: 'fixture-session' },
      { apikey: 'wrong' },
      { 'x-api-key': 'fixture-report-api-secret' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/report-deliveries',
        headers,
        payload: { input: { kind: 'hyperlocal-summary' } },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('fixture-report-api-secret');
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/report-deliveries?apikey=fixture-report-api-secret',
          payload: { input: { kind: 'hyperlocal-summary' } },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/report-deliveries',
          headers: { apikey: 'fixture-report-api-secret' },
          payload: { input: { kind: 'unsupported' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(builds).toBe(0);
  });
  it('posts each message synchronously to its channel and answers "Data Sent"', async () => {
    const built: unknown[] = [];
    const { app, posts, run } = fixture(async (input) => {
      built.push(input);
      return {
        recordCount: 3,
        messages: [
          { target: 'main', text: 'Main body' },
          { target: 'demo', text: 'Demo body' },
        ],
      };
    });
    await registerScheduledReportRoutes(app, run, options);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/report-deliveries',
      headers: { apikey: 'fixture-report-api-secret' },
      payload: { input: { kind: 'hyperlocal-delivery-delays' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'success', message: 'Data Sent', recordCount: 3 });
    expect(built).toEqual([
      {
        kind: 'hyperlocal-delivery-delays',
        date: '2026-11-16',
        previousDays: 1,
        sendToSlack: true,
        includeCompleted: false,
      },
    ]);
    expect(posts).toEqual([
      { url: options.SLACK_URL, text: 'Main body' },
      { url: options.SLACK_DEMO_URL, text: 'Demo body' },
    ]);
  });
  it('keeps the legacy CRM "Data Updated In DB" answer and option guards', async () => {
    const { posts, run } = fixture(async () => ({ recordCount: 2, messages: [] }));
    await expect(
      run({ kind: 'crm-tickets', sendToSlack: false, previousDays: 3 }),
    ).resolves.toMatchObject({ message: 'Data Updated In DB' });
    await expect(run({ kind: 'hyperlocal-summary', previousDays: 2 })).rejects.toMatchObject({
      code: 'INVALID_REPORT_OPTIONS',
    });
    await expect(
      run({ kind: 'hyperlocal-store-status', date: '2026-11-16' }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE' });
    expect(posts).toEqual([]);
  });
  it('a failed Slack post is dropped, as legacy, and the request still succeeds', async () => {
    const events: Record<string, unknown>[] = [],
      run = scheduledReportRunner(
        config,
        options,
        async () => ({ recordCount: 1, messages: [{ target: 'main', text: 'private body' }] }),
        async () => false,
        now,
      );
    await expect(
      run({ kind: 'hyperlocal-summary' }, (_level, event) => events.push({ ...event }), 'req-1'),
    ).resolves.toMatchObject({ message: 'Data Sent' });
    expect(events).toEqual([
      expect.objectContaining({
        eventId: 'operational-reports.scheduled-report-delivery.not-sent',
        requestId: 'req-1',
        target: 'main',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private body');
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });
  it('only contacts credential-free HTTPS Slack webhooks', () => {
    expect(slackWebhookAllowed('https://hooks.slack.com/services/A/B/C')).toBe(true);
    expect(slackWebhookAllowed('http://hooks.slack.com/services/A/B/C')).toBe(false);
    expect(slackWebhookAllowed('https://example.com/services/A/B/C')).toBe(false);
    expect(slackWebhookAllowed('https://hooks.slack.com/services/A?x=1')).toBe(false);
    expect(slackWebhookAllowed(undefined)).toBe(false);
  });
});
