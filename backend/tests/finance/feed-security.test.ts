import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import Fastify from 'fastify';
import type { Databases } from '../../src/db/pools.js';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { AppError } from '../../src/domain/errors.js';
import type { Principal } from '../../src/domain/access.js';
import { registerFinance } from '../../src/modules/finance/index.js';
import { financeFeedOptions } from '../../src/modules/finance/feed.js';
import { reconciliationPage } from '../../src/modules/finance/feed-domain.js';
import { financeAlertOptions } from '../../src/modules/finance/alerts.js';
const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'feed-security-fixture-'.repeat(3),
  }),
  key = 'isolated-feed-fixture-secret-'.repeat(2);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe('reconciliation service authentication', () => {
  it('rejects absent/wrong service credentials before DB work even for a signed-in superadmin', async () => {
    let databaseCalls = 0,
      feedCalls = 0;
    const db: Databases = {
      get: () => {
        databaseCalls++;
        throw new Error('Unexpected DB work');
      },
      close: async () => {},
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      if (request.headers.cookie === 'fixture-session')
        request.principal = {
          id: '10',
          name: 'Fixture',
          email: 'fixture@example.test',
          role: 1,
          userType: 1,
          storeIds: ['1'],
        } satisfies Principal;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 400)
        .send({ code: error instanceof AppError ? error.code : 'INVALID_REQUEST' }),
    );
    await registerFinance(app, config, db, {
      ephemeral: memoryEphemeralStore(),
      feedOptions: financeFeedOptions({ GLASSBOX_FINANCE_FEED_API_KEY: key }),
      feed: {
        orders: async () => {
          feedCalls++;
          return reconciliationPage([], 1, 100);
        },
      },
      alertOptions: financeAlertOptions({ REPORTS_API_KEY: key }),
    });
    for (const headers of [
      {},
      { cookie: 'fixture-session' },
      { cookie: 'fixture-session', 'x-api-key': 'wrong' },
    ]) {
      const response = await app.inject({
        url: '/api/v1/finance/reconciliation/orders?from=2026-11-16&to=2026-11-16&page=1&page_size=100',
        headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(key);
    }
    expect(databaseCalls).toBe(0);
    expect(feedCalls).toBe(0);
    for (const headers of [
      {},
      { cookie: 'fixture-session' },
      { cookie: 'fixture-session', apikey: 'wrong' },
      { 'x-api-key': key },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/day-close-alerts',
        headers,
        payload: { commandId: crypto.randomUUID() },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(databaseCalls).toBe(0);
    const invalid = await app.inject({
      url: '/api/v1/finance/reconciliation/orders?from=invalid&to=2026-11-16&page=1&page_size=100',
      headers: { 'x-api-key': key },
    });
    expect(invalid.statusCode).toBe(400);
    expect(databaseCalls).toBe(0);
    expect(feedCalls).toBe(0);
    const valid = await app.inject({
      url: '/api/v1/finance/reconciliation/orders?from=2026-11-16&to=2026-11-16&page=1&page_size=100',
      headers: { 'x-api-key': key },
    });
    expect(valid.statusCode).toBe(200);
    expect(feedCalls).toBe(1);
    expect(databaseCalls).toBe(0);
  });
});
