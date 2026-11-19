import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as pools from '../../src/db/pools.js';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { tracedFetch, withRequestTrace } from '../../src/observability/context.js';

/** Phase E3: trace fields on every line, inbound X-Request-Id handling, and PII redaction. */
const pii = {
  email: 'redaction-canary@example.test',
  phone: '9876501234',
  password: 'redaction-password-canary',
  otp: '493817',
  token: 'redaction-token-canary',
  name: 'Redaction Canary Name',
  address: 'Flat 9 Canary Lane',
  sql: 'SELECT secret_canary FROM pos_user',
};
const line = z.object({
  traceId: z.uuid(),
  requestId: z.uuid(),
  module: z.string().regex(/^[a-z][a-z0-9-]*$/),
  resource: z.string().regex(/^[a-z][a-z0-9-]*$/),
  eventId: z.string().min(1),
  eventInstanceId: z.uuid(),
  userId: z.string().nullable(),
});
function configuration() {
  return readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://synthetic:synthetic@127.0.0.1:9/pos_log_redaction',
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    SESSION_SECRET: 'log-redaction-only-fixture-key-'.repeat(2),
  });
}
async function withApp(
  test: (app: Awaited<ReturnType<typeof buildApp>>, lines: string[]) => Promise<void>,
) {
  const lines: string[] = [];
  const app = await buildApp(configuration(), {
    logger: { level: 'trace', stream: { write: (value: string) => void lines.push(value) } },
  });
  try {
    await test(app, lines);
  } finally {
    await app.close();
  }
}
function assertNoPii(lines: string[]) {
  const output = lines.join('');
  for (const value of Object.values(pii)) expect(output).not.toContain(value);
  for (const key of ['"password"', '"phone"', '"email"', '"body"', '"query"', '"cookie"'])
    expect(output).not.toContain(key);
}
beforeEach(() => {
  vi.spyOn(pools, 'createDatabases').mockReturnValue({
    get: () => {
      throw Object.assign(new Error(pii.sql), { code: 'ER_PARSE_ERROR', sqlMessage: pii.sql });
    },
    close: async () => undefined,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('request tracing', () => {
  it('honours a UUID X-Request-Id, echoes it, and replaces anything else', async () => {
    await withApp(async (app) => {
      const inbound = crypto.randomUUID();
      const honoured = await app.inject({
        url: '/health/live',
        headers: { 'x-request-id': inbound },
      });
      expect(honoured.headers['x-request-id']).toBe(inbound);
      const replaced = await app.inject({
        url: '/health/live?unexpected=1',
        headers: { 'x-request-id': `${pii.email}\n{"forged":true}` },
      });
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(replaced.headers['x-request-id']).not.toBe(inbound);
      expect(replaced.json<{ error: { requestId: string } }>().error.requestId).toBe(
        replaced.headers['x-request-id'],
      );
    });
  });
  it('forwards the trace to outbound calls only inside a request or job context', async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('x-request-id'));
        return new Response('{}');
      }),
    );
    try {
      const traceId = crypto.randomUUID();
      await withRequestTrace(
        { requestId: traceId, userId: '1', module: 'checkout', resource: 'order' },
        () => tracedFetch('https://api.example.test/pos/order', { headers: { a: 'b' } }),
      );
      await tracedFetch('https://api.example.test/pos/order');
      expect(seen).toEqual([traceId, null]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PII-free structured logs', () => {
  it('logs a request carrying PII in its body, query, headers and a SQL failure without any of it', async () => {
    await withApp(async (app, lines) => {
      const requestId = crypto.randomUUID();
      await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sessions?email=${encodeURIComponent(pii.email)}&phone=${pii.phone}`,
        headers: {
          origin: 'http://localhost:5173',
          'x-request-id': requestId,
          authorization: `Bearer ${pii.token}`,
          cookie: `pos_session=${pii.token}`,
        },
        payload: { username: pii.email, password: pii.password, otp: pii.otp, phone: pii.phone },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        headers: { origin: 'http://localhost:5173', 'x-request-id': requestId },
        payload: { username: pii.email, password: pii.password },
      });
      assertNoPii(lines);
      const parsed = lines.map((value) => line.parse(JSON.parse(value)));
      expect(parsed.length).toBeGreaterThan(0);
      for (const row of parsed) {
        expect(row.traceId).toBe(row.requestId);
        expect(row.requestId).toBe(requestId);
      }
    });
  });
  it('redacts sensitive keys passed directly to the logger and stamps the active trace', async () => {
    await withApp(async (app, lines) => {
      const requestId = crypto.randomUUID();
      withRequestTrace({ requestId, userId: '42', module: 'checkout', resource: 'customer' }, () =>
        app.log.info(
          {
            eventId: 'checkout.customer.lookup',
            password: pii.password,
            phone: pii.phone,
            email: pii.email,
            body: { name: pii.name },
            customer: { telephone: pii.phone, address: pii.address, contact: { email: pii.email } },
            failure: { sqlMessage: pii.sql, otp: pii.otp },
            headers: { authorization: pii.token },
          },
          'Customer lookup',
        ),
      );
      assertNoPii(lines);
      const row = line.parse(JSON.parse(lines.at(-1)!));
      expect(row).toMatchObject({
        traceId: requestId,
        requestId,
        module: 'checkout',
        resource: 'customer',
        userId: '42',
        eventId: 'checkout.customer.lookup',
      });
    });
  });
});
