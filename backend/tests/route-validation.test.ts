import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import * as pools from '../src/db/pools.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { registeredRoutes, type RegisteredRoute } from '../src/domain/route-validation.js';

/**
 * Phase E2: every registered route declares zod schemas for each request part it accepts.
 *   - params:      required when the URL has parameters; a strict object with exactly those keys.
 *   - querystring: required on every route; strict (a route without a query uses `noQuery`).
 *   - body:        required on POST/PUT/PATCH/DELETE (a route without a body uses `noBody`).
 *   - headers:     required on every route; a loose object (transport headers vary by client,
 *                  the documented exception) that declares every header the handler reads.
 * Objects reachable from params/querystring/body must be strict and contain no `any`/`unknown`.
 */
const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Documented exceptions, `METHOD /url` → reason. Keep empty unless legacy requires passthrough. */
const exceptions: Record<string, string> = {
  'GET /user_to_app':
    'Printed customer QR codes are opened by third-party scanners that may append parameters; ' +
    'legacy UserToApp (core/views.py:3182) reads only store_id and ignores the rest. ' +
    'store_id itself is strictly validated; other keys are stripped.',
};

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  in?: z.ZodType;
  innerType?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  getter?: () => z.ZodType;
};
const def = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Unwrap wrappers (pipe input, optional, default…) down to the schema that receives input. */
function inputRoot(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let depth = 0; depth < 20; depth += 1) {
    const d = def(current);
    if (d.type === 'pipe' && d.in) current = d.in;
    else if (d.innerType) current = d.innerType;
    else if (d.type === 'lazy' && d.getter) current = d.getter();
    else return current;
  }
  return current;
}

/** Strictness problems reachable from a request schema (input side only). */
function strictnessProblems(
  schema: z.ZodType,
  path: string,
  seen = new Set<z.ZodType>(),
): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const d = def(schema);
  const at = path || '<root>';
  switch (d.type) {
    case 'any':
    case 'unknown':
      return [`unvalidated ${d.type} at ${at}`];
    case 'object': {
      const own =
        d.catchall && def(d.catchall).type === 'never'
          ? []
          : [`non-strict object at ${at} (use z.strictObject or .strict())`];
      return [
        ...own,
        ...Object.entries(d.shape ?? {}).flatMap(([key, value]) =>
          strictnessProblems(value, path ? `${path}.${key}` : key, seen),
        ),
      ];
    }
    case 'pipe':
      return d.in ? strictnessProblems(d.in, path, seen) : [];
    case 'lazy':
      return d.getter ? strictnessProblems(d.getter(), path, seen) : [];
    case 'array':
      return d.element ? strictnessProblems(d.element, `${path}[]`, seen) : [];
    case 'record':
      return d.valueType ? strictnessProblems(d.valueType, `${path}{}`, seen) : [];
    case 'union':
      return (d.options ?? []).flatMap((option) => strictnessProblems(option, path, seen));
    case 'intersection':
      return [d.left, d.right].flatMap((side) =>
        side ? strictnessProblems(side, path, seen) : [],
      );
    case 'tuple':
      return [...(d.items ?? []), ...(d.rest ? [d.rest] : [])].flatMap((item, index) =>
        strictnessProblems(item, `${path}[${index}]`, seen),
      );
    default:
      return d.innerType ? strictnessProblems(d.innerType, path, seen) : [];
  }
}

/** Header names the handler reads directly (`headers['x-…']`, `headers.name`). */
function headersRead(handler: RegisteredRoute['handler']): string[] {
  const source = handler.toString(),
    names = new Set<string>();
  for (const match of source.matchAll(/headers\[\s*['"]([A-Za-z0-9-]+)['"]\s*\]/g))
    names.add(match[1]!.toLowerCase());
  for (const match of source.matchAll(/request\.headers\.([A-Za-z][A-Za-z0-9]*)/g))
    names.add(match[1]!.toLowerCase());
  return [...names];
}

function routeProblems(route: RegisteredRoute): string[] {
  const schema = route.schema ?? {},
    problems: string[] = [];
  const urlParams = [...route.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  if (route.url.includes('*')) urlParams.push('*');
  if (urlParams.length) {
    if (!schema.params) problems.push('missing params schema');
    else {
      const root = def(inputRoot(schema.params));
      if (root.type !== 'object') problems.push('params schema is not an object');
      else {
        const keys = Object.keys(root.shape ?? {}).sort();
        if (keys.join(',') !== [...urlParams].sort().join(','))
          problems.push(
            `params keys [${keys.join(',')}] do not match URL [${urlParams.join(',')}]`,
          );
      }
      problems.push(...strictnessProblems(schema.params, 'params'));
    }
  }
  if (!schema.querystring) problems.push('missing querystring schema');
  else {
    if (def(inputRoot(schema.querystring)).type !== 'object')
      problems.push('querystring schema is not an object');
    problems.push(...strictnessProblems(schema.querystring, 'query'));
  }
  if (bodyMethods.has(route.method)) {
    if (!schema.body) problems.push('missing body schema');
    else problems.push(...strictnessProblems(schema.body, 'body'));
  }
  if (!schema.headers) problems.push('missing headers schema');
  else {
    const root = def(inputRoot(schema.headers));
    if (root.type !== 'object') problems.push('headers schema is not an object');
    else
      for (const name of headersRead(route.handler))
        if (!(name in (root.shape ?? {})))
          problems.push(`handler reads header ${name} but the headers schema does not declare it`);
  }
  return problems;
}

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  vi.spyOn(pools, 'createDatabases').mockReturnValue({
    get: () => {
      throw new Error('Unexpected fixture database I/O');
    },
    close: async () => undefined,
  });
  app = await buildApp(
    readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      MYSQL_PRIMARY_READER_URL: 'mysql://synthetic:synthetic@127.0.0.1:9/pos_route_validation',
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      SESSION_SECRET: 'route-validation-only-fixture-key-'.repeat(2),
    }),
  );
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

describe('route validation coverage', () => {
  it('declares strict zod schemas for every input of every registered route', () => {
    const routes = registeredRoutes(app).filter(
      (route) => route.method !== 'HEAD' && route.method !== 'OPTIONS',
    );
    expect(routes.length).toBeGreaterThan(300);
    const failures = routes.flatMap((route) => {
      const key = `${route.method} ${route.url}`;
      if (exceptions[key]) return [];
      return routeProblems(route).map((problem) => `${key}: ${problem}`);
    });
    const covered = routes.length - new Set(failures.map((f) => f.split(': ')[0])).size;
    process.stdout.write(`route-validation: ${covered}/${routes.length} routes fully covered\n`);
    if (failures.length) process.stdout.write(`${failures.join('\n')}\n`);
    expect(failures).toEqual([]);
  });

  it('every documented exception names a registered route', () => {
    const keys = new Set(registeredRoutes(app).map((route) => `${route.method} ${route.url}`));
    for (const key of Object.keys(exceptions)) expect(keys.has(key)).toBe(true);
  });
});

describe('validation error contract', () => {
  const canary = 'validation-canary-9876543210@example.test';
  it('rejects unknown query keys with a stable 400 that never echoes values or key names', async () => {
    const response = await app.inject({
      url: `/health/live?${encodeURIComponent(canary)}=${canary}`,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toMatch(/\S/);
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
    expect(response.body).not.toContain('validation-canary');
    expect(response.body).not.toContain('9876543210');
  });
  it('rejects unknown body fields and malformed values without echoing personal data', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions',
      headers: { origin: 'http://localhost:5173' },
      payload: { username: 7, password: canary, [canary]: canary, phone: '9876543210' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; fields: { path: string }[] } }>();
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.fields.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('validation-canary');
    expect(response.body).not.toContain('9876543210');
  });
});

describe('S50: authentication runs before validation on session routes', () => {
  const origin = 'http://localhost:5173';
  const publicRoutes = [
    'DELETE /api/v1/auth/sessions/current',
    'GET /api/v1/auth/capabilities',
    'GET /api/v1/auth/challenges/current',
    'GET /health/live',
    'GET /health/ready',
    'POST /api/v1/auth/challenges/current/resends',
    'POST /api/v1/auth/challenges/current/verifications',
    'POST /api/v1/auth/demo-sessions',
    'POST /api/v1/auth/sessions',
  ];
  it('marks only the login and health routes public; everything else needs a session or a service proof', () => {
    const marked = registeredRoutes(app)
      .filter((route) => route.method !== 'HEAD' && route.authentication === 'public')
      .map((route) => `${route.method} ${route.url}`)
      .sort();
    // The demo-session route disappears when demo mode is removed (W10).
    const demo = 'POST /api/v1/auth/demo-sessions';
    expect(marked).toEqual(publicRoutes.filter((key) => key !== demo || marked.includes(key)));
  });
  it('answers 401 to unauthenticated calls with invalid params, query, body or JSON, never a shape 400', async () => {
    for (const request of [
      { method: 'GET' as const, url: '/api/v1/stores/not-an-id/counters' },
      { method: 'GET' as const, url: '/api/v1/stores?unexpected=9876543210' },
      {
        method: 'POST' as const,
        url: '/api/v1/stores/1/checkout-sessions',
        headers: { origin },
        payload: { unexpected: '9876543210' },
      },
      {
        method: 'PUT' as const,
        url: '/api/v1/stores/1/cart-drafts/not-a-uuid',
        headers: { origin, 'content-type': 'application/json' },
        payload: '{"broken":',
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string; fields?: unknown } }>().error).toMatchObject({
        code: 'AUTH_REQUIRED',
      });
      expect(response.json<{ error: { fields?: unknown } }>().error.fields).toBeUndefined();
      expect(response.body).not.toContain('9876543210');
    }
  });
  it('keeps validating first on public and service routes', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions?unexpected=1',
      headers: { origin },
      payload: { username: 'operator' },
    });
    expect(login.statusCode).toBe(400);
    expect(login.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');
    const scan = await app.inject({ url: '/user_to_app?store_id=not-a-store' });
    expect(scan.statusCode).toBe(400);
    const webhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/day-close-alerts',
      payload: { unexpected: true },
    });
    // The webhook's own API-key guard answers, not the session gate.
    expect(webhook.statusCode).toBe(401);
    expect(webhook.json<{ error: { code: string } }>().error.code).not.toBe('AUTH_REQUIRED');
  });
});
