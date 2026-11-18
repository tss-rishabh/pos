import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';

const stores = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
});

describe('daily report store options in the isolated demo', () => {
  it('uses only authenticated synthetic stores while financial reads remain disabled', async () => {
    const origin = 'http://localhost:5173';
    const app = await buildApp(
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        WEB_ORIGIN: origin,
        SESSION_SECRET: 'demo-report-options-fixture-'.repeat(3),
      }),
      { logger: false },
    );
    try {
      const path = '/api/v1/reports/store-cash-balances/stores';
      expect((await app.inject({ url: path })).statusCode).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/demo-sessions',
        headers: { origin },
      });
      expect(login.statusCode).toBe(201);
      const credential = login.cookies[0];
      if (!credential) throw new Error('DEMO_SESSION_COOKIE_REQUIRED');
      const headers = { cookie: `${credential.name}=${credential.value}` };
      const catalog = await app.inject({ url: '/api/v1/stores', headers });
      expect(catalog.statusCode).toBe(200);
      const options = await app.inject({ url: path, headers });
      expect(options.statusCode).toBe(200);
      expect(stores.parse(options.json<unknown>()).data).toEqual(
        stores.parse(catalog.json<unknown>()).data.map(({ id, name }) => ({ id, name })),
      );
      const financial = await app.inject({
        url: '/api/v1/reports/store-cash-balances',
        headers,
      });
      expect(financial.statusCode).toBe(403);
      expect(financial.json<unknown>()).toMatchObject({ error: { code: 'DEMO_READ_ONLY' } });
    } finally {
      await app.close();
    }
  });
});
