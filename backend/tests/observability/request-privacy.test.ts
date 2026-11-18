import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as pools from '../../src/db/pools.js';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { resourceRoutes } from '../../src/observability/events.js';

const fixtures = {
  identity: 'synthetic-identity-canary',
  password: 'synthetic-password-canary',
  token: 'synthetic-token-canary',
  query: 'synthetic-query-canary',
  database: 'synthetic-database-canary',
  provider: 'synthetic-provider-canary',
};
const event = z.object({
  module: z.string().regex(/^[a-z][a-z0-9-]*$/),
  resource: z.string().regex(/^[a-z][a-z0-9-]*$/),
  eventId: z.string(),
  eventInstanceId: z.uuid(),
  requestId: z.uuid(),
  userId: z.string().nullable(),
  method: z.string(),
  status: z.number(),
});
function configuration(extra: NodeJS.ProcessEnv = {}) {
  return readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    MYSQL_PRIMARY_READER_URL: 'mysql://synthetic:synthetic@127.0.0.1:9/pos_observability_fixture',
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    SESSION_SECRET: 'request-privacy-only-fixture-key-'.repeat(2),
    ...extra,
  });
}
function logger(lines: string[]) {
  return {
    level: 'trace',
    stream: {
      write: (line: string) => {
        lines.push(line);
      },
    },
  };
}
function safe(lines: string[]) {
  const output = lines.join('');
  for (const value of Object.values(fixtures)) expect(output).not.toContain(value);
  for (const field of [
    'authorization',
    'cookie',
    'password',
    'parameters',
    'sqlMessage',
    'cause',
    'url',
    'body',
    'headers',
    'query',
    'err',
    'stack',
    'config',
    'response',
  ])
    expect(output).not.toContain('"' + field + '"');
  return lines.map((line) => JSON.parse(line) as unknown).map((row) => event.parse(row));
}
beforeEach(() => {
  vi.spyOn(pools, 'createDatabases').mockReturnValue({
    get: () => {
      throw new Error('Unexpected fixture database I/O');
    },
    close: async () => undefined,
  });
});
afterEach(() => vi.restoreAllMocks());
describe('registered application request privacy at trace level', () => {
  it('keeps unknown paths, query strings and malformed JSON out of framework and resource logs', async () => {
    const lines: string[] = [],
      app = await buildApp(configuration(), { logger: logger(lines) });
    try {
      await app.ready();
      const routes = resourceRoutes(app);
      expect(routes.length).toBeGreaterThan(20);
      expect(
        routes.every((route) =>
          [route.module, route.resource, route.action].every((value) =>
            /^[a-z][a-z0-9-]*$/.test(value),
          ),
        ),
      ).toBe(true);
      const missing = await app.inject({
        url: '/' + fixtures.identity + '?code=' + fixtures.token + '&q=' + fixtures.query,
        headers: {
          authorization: 'Bearer ' + fixtures.token,
          cookie: 'probe=' + fixtures.password,
          'x-request-id': fixtures.token,
        },
      });
      expect(missing.statusCode).toBe(404);
      const malformed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions?code=' + fixtures.query,
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        payload: '{"password":"' + fixtures.password + '", "' + fixtures.identity + '":',
      });
      expect(malformed.statusCode).toBe(400);
      const events = safe(lines);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventId: 'system.http-request.handle.failed', status: 404 }),
          expect.objectContaining({ eventId: 'identity.session.create.failed', status: 400 }),
        ]),
      );
      expect(new Set(events.map((value) => value.requestId)).size).toBe(2);
    } finally {
      await app.close();
    }
  });
  it('does not serialize a database exception, its SQL/parameters, or its nested provider cause', async () => {
    const lines: string[] = [];
    const failure = Object.assign(new Error(fixtures.database), {
      query: fixtures.query,
      parameters: [fixtures.identity, fixtures.password],
      sqlMessage: fixtures.database,
      cause: Object.assign(new Error(fixtures.provider), {
        config: { headers: { authorization: fixtures.token } },
        response: { data: fixtures.identity },
      }),
    });
    vi.spyOn(pools, 'createDatabases').mockReturnValue({
      get: () => {
        throw failure;
      },
      close: async () => undefined,
    });
    const app = await buildApp(configuration(), { logger: logger(lines) });
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        headers: { origin: 'http://localhost:5173' },
        payload: { username: fixtures.identity, password: fixtures.password },
      });
      expect(result.statusCode).toBe(500);
      const events = safe(lines);
      expect(
        events.some(
          (row) =>
            row.eventId === 'identity.session.create.failed' &&
            row.userId === null &&
            row.status === 500,
        ),
      ).toBe(true);
      for (const value of Object.values(fixtures)) expect(result.body).not.toContain(value);
    } finally {
      await app.close();
    }
  });
  it('maps a real registered SSO provider failure without logging SDK messages, tokens or causes', async () => {
    const lines: string[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error(fixtures.provider), {
        cause: new Error(fixtures.token),
        response: { data: fixtures.identity },
      }),
    );
    const app = await buildApp(
      configuration({
        OIDC_ISSUER: 'https://accounts.google.com',
        OIDC_CLIENT_ID: 'synthetic-client',
        OIDC_CLIENT_SECRET: fixtures.token,
        OIDC_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/sso/callback',
        OIDC_EMAIL_DOMAINS: 'example.test',
      }),
      { logger: logger(lines) },
    );
    try {
      const result = await app.inject({ url: '/api/v1/auth/sso/login' });
      expect(result.statusCode).toBe(503);
      expect(fetcher).toHaveBeenCalled();
      expect(safe(lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventId: 'identity.sso-authorization.create.failed',
            status: 503,
          }),
        ]),
      );
      for (const value of Object.values(fixtures)) expect(result.body).not.toContain(value);
    } finally {
      await app.close();
    }
  });
});
