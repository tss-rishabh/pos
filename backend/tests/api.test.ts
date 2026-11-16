import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const origin = 'http://localhost:5173';
const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'test-session-secret-'.repeat(3),
});
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
beforeEach(async () => {
  app = await buildApp(config);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/demo-sessions',
    headers: { origin },
  });
  cookie = response.cookies[0]!.name + '=' + response.cookies[0]!.value;
});
afterEach(async () => {
  await app.close();
});
describe('API authorization, validation, and durable-operation contract', () => {
  it('requires a session and enforces assigned stores', async () => {
    expect((await app.inject('/api/v1/stores')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/v1/stores/99/catalog/products', headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    const response = await app.inject({
      url: '/api/v1/stores/1/catalog/products',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/);
  });
  it('validates limits, sort injection, unexpected fields and malformed IDs', async () => {
    for (const url of [
      '/api/v1/stores/1/catalog/products?limit=-1',
      '/api/v1/stores/1/catalog/products?sort=price%3Bdrop',
      '/api/v1/stores/not-an-id/catalog/products',
      '/api/v1/stores/1/orders?before=1%20OR%201=1',
    ])
      expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(400);
  });
  it('rejects cross-site mutation requests, including login', async () => {
    for (const headers of [{}, { origin: 'https://evil.example' }])
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/auth/demo-sessions', headers }))
          .statusCode,
      ).toBe(403);
  });
  it('returns the same version for retries and rejects reusing an operation ID with new data', async () => {
    const draftId = crypto.randomUUID(),
      mutationId = crypto.randomUUID();
    const payload = {
      mutationId,
      expectedVersion: 0,
      draft: {
        id: draftId,
        storeId: '1',
        counterId: '1',
        customerId: null,
        lines: [
          { productId: '1001', name: 'Sample', barcode: null, unitPrice: '999.00', quantity: 1 },
        ],
      },
    };
    const save = () =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/stores/1/cart-drafts/${draftId}`,
        headers: { origin, cookie, 'x-operator-id': '900001' },
        payload,
      });
    const responses = await Promise.all([save(), save(), save()]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.json<{ version: number }>().version)).toEqual([1, 1, 1]);
    payload.draft.lines[0]!.quantity = 2;
    expect((await save()).statusCode).toBe(409);
    payload.mutationId = crypto.randomUUID();
    expect((await save()).statusCode).toBe(409);
  });
  it('does not allow body store IDs to override the resource scope', async () => {
    const id = crypto.randomUUID();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/stores/1/cart-drafts/${id}`,
      headers: { origin, cookie, 'x-operator-id': '900001' },
      payload: {
        mutationId: crypto.randomUUID(),
        expectedVersion: 0,
        draft: { id, storeId: '2', counterId: '1', customerId: null, lines: [] },
      },
    });
    expect(response.statusCode).toBe(400);
  });
  it('prevents development identities and plaintext service origins in production', () => {
    expect(() =>
      readConfig({ ...config, NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
