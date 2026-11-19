import Fastify from 'fastify';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { registerCheckout } from '../../src/modules/checkout/index.js';
import { AppError } from '../../src/domain/errors.js';
import { registerEventCatalog, resourceRoutes } from '../../src/observability/events.js';
import { checkoutFlags } from '../../src/modules/checkout/legacy-flags.js';
import {
  FixtureGateway,
  MemoryCheckoutRepository,
  operator,
  signingEnvironment,
} from './fixtures.js';

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'checkout-route-fixture-secret-'.repeat(2),
    }),
    db = createDatabases(config);
  app = Fastify({ logger: false });
  registerEventCatalog(app);
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (request) => {
    request.principal = request.headers['x-test-anonymous'] === 'true' ? null : operator;
  });
  app.setErrorHandler((error, _request, reply) =>
    error instanceof AppError
      ? reply.code(error.status).send({ error: { code: error.code } })
      : error instanceof ZodError
        ? reply.code(400).send({ error: { code: 'INVALID_REQUEST' } })
        : reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } }),
  );
  registerCheckout(app, config, db, {
    repository: new MemoryCheckoutRepository(),
    gateway: new FixtureGateway(),
    environment: signingEnvironment,
    assertCheckIn: async () => {},
    finalizeOrder: async () => ({ transactionId: 'FIXTURE', invoice: 'FIXTURE' }),
    checkoutFlags: async (user) => checkoutFlags(config, 'IN_HOUSE', user.userType),
  });
  app.addHook('onClose', async () => db.close());
  await app.ready();
});
afterEach(async () => {
  await app.close();
});
describe('validated checkout HTTP boundaries', () => {
  const base = '/api/v1/stores/1/checkout-sessions';
  it('requires a saved draft and returns the same checkout on repeated creation', async () => {
    expect(
      (await app.inject({ method: 'POST', url: base, payload: { counterId: '3' } })).statusCode,
    ).toBe(400);
    const draftId = crypto.randomUUID(),
      payload = { counterId: '3', draftId, draftVersion: 0, lineItems: [] };
    const first = await app.inject({ method: 'POST', url: base, payload }),
      second = await app.inject({ method: 'POST', url: base, payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json<{ id: string; draftId: string }>()).toMatchObject(
      first.json<{ id: string; draftId: string }>(),
    );
    expect(first.json<{ draftId: string }>().draftId).toBe(draftId);
  });
  it('records explicit resource trace metadata for every checkout and payment route', () => {
    const routes = resourceRoutes(app);
    expect(routes).toHaveLength(80);
    expect(
      routes.every((route) => route.module === 'checkout' && route.authentication === 'session'),
    ).toBe(true);
    expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(80);
    const returnWindow = '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/return-window';
    expect(routes.filter((route) => route.resource === 'return-window-extension')).toEqual([
      {
        module: 'checkout',
        resource: 'return-window-extension',
        action: 'read',
        method: 'GET',
        path: returnWindow,
        authentication: 'session',
      },
      {
        module: 'checkout',
        resource: 'return-window-extension',
        action: 'update',
        method: 'PUT',
        path: returnWindow,
        authentication: 'session',
      },
    ]);
    // Legacy order copy is one action (ajax-fetch-the-products); no review/cancellation journal.
    expect(
      routes.filter((route) => ['order-copy', 'order-copy-review'].includes(route.resource)),
    ).toHaveLength(1);
    expect(routes.filter((route) => route.resource === 'order-copy-cancellation')).toHaveLength(0);
    expect(
      routes.filter((route) =>
        ['order-payment-status', 'order-payment-context', 'pending-order-cancellation'].includes(
          route.resource,
        ),
      ),
    ).toHaveLength(4);
  });
  it('rejects unbound cancellation/payment-status bodies and anonymous actors before any writer use', async () => {
    const root = '/api/v1/stores/1/orders/9007199254740993';
    for (const [path, payload] of [
      ['/cancellations', { operationId: crypto.randomUUID(), snapshotHash: 'invalid' }],
      [
        '/cancellations',
        { operationId: crypto.randomUUID(), snapshotHash: 'a'.repeat(64), paymentStatus: 4 },
      ],
      ['/payment-status', { payType: 2 }],
      ['/payment-status', { payType: 1, offlinePayment: '100', p_status: 4 }],
    ] as const)
      expect((await app.inject({ method: 'POST', url: root + path, payload })).statusCode).toBe(
        400,
      );
    for (const [path, payload] of [
      // Legacy AjaxOrderCancelView takes no body.
      ['/cancellations', {}],
      ['/payment-status', { payType: 0 }],
    ] as const)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: root + path,
            headers: { 'x-test-anonymous': 'true' },
            payload,
          })
        ).statusCode,
      ).toBe(401);
  });
  it('accepts only four digits (legacy customer OTP) and original opaque action IDs at verification HTTP boundaries', async () => {
    const checkoutId = crypto.randomUUID(),
      verificationId = crypto.randomUUID();
    for (const otp of ['123', '12_34', '12345', 'abcd']) {
      const response = await app.inject({
        method: 'POST',
        url: `${base}/${checkoutId}/customer-verification/confirmations`,
        payload: { operationId: crypto.randomUUID(), expectedVersion: 0, otp },
      });
      expect(response.statusCode).toBe(400);
    }
    for (const url of [
      `${base}/${checkoutId}/customer-verification/reconciliations`,
      `/api/v1/stores/1/return-verifications/${verificationId}/reconciliations`,
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { operationId: 'not-an-id', expectedVersion: 0, otp: '123456' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { 'x-test-anonymous': 'true' },
            payload: { operationId: crypto.randomUUID(), expectedVersion: 0 },
          })
        ).statusCode,
      ).toBe(401);
    }
  });
  it('validates the source ledger note before accepting an operation and never puts its text in general state', async () => {
    const created = await app.inject({
      method: 'POST',
      url: base,
      payload: {
        counterId: '3',
        draftId: crypto.randomUUID(),
        draftVersion: 0,
        lineItems: [],
      },
    });
    const { id } = created.json<{ id: string }>(),
      path = `${base}/${id}`;
    await app.inject({
      method: 'POST',
      url: path + '/quotes',
      payload: {
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
      },
    });
    for (const message of ['😀', '\u2015', 'x'.repeat(256), '   ']) {
      const invalid = await app.inject({
        method: 'PUT',
        url: path + '/settlement-note',
        payload: {
          operationId: crypto.randomUUID(),
          expectedVersion: 1,
          message,
          cashReceived: '100.00',
        },
      });
      expect(invalid.statusCode).toBe(400);
    }
    const message = 'PRIVATE-NOTE-CANARY\nCafé';
    const saved = await app.inject({
      method: 'PUT',
      url: path + '/settlement-note',
      payload: {
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        message,
        cashReceived: '100.00',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('PRIVATE-NOTE-CANARY');
    expect((await app.inject({ method: 'GET', url: path })).body).not.toContain(
      'PRIVATE-NOTE-CANARY',
    );
    expect(
      (await app.inject({ method: 'GET', url: path + '/settlement-note' })).json(),
    ).toMatchObject({ message });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: path + '/settlement-note',
          headers: { 'x-test-anonymous': 'true' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('accepts customer contacts only in a strict checked-in POST body', async () => {
    const path = '/api/v1/stores/1/customer-lookups';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: { query: 'customer-1001@example.test', counterId: '3' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: { query: 'customer-1001@example.test' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: { query: 'customer-1001@example.test', counterId: '3', self_verify: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/stores/1/customers/lookup?query=fixture' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/stores/2/customer-lookups',
          payload: { query: '9000000000', counterId: '3' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('rejects unauthenticated, unassigned and forged browser verification requests', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base,
          headers: { 'x-test-anonymous': 'true' },
          payload: { counterId: '3', draftId: crypto.randomUUID(), draftVersion: 0, lineItems: [] },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base.replace('/1/', '/2/'),
          payload: { counterId: '3', draftId: crypto.randomUUID(), draftVersion: 0, lineItems: [] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base,
          payload: {
            counterId: '3',
            draftId: crypto.randomUUID(),
            draftVersion: 0,
            lineItems: [],
            auth_token: 'forged',
          },
        })
      ).statusCode,
    ).toBe(400);
    const created = await app.inject({
        method: 'POST',
        url: base,
        payload: { counterId: '3', draftId: crypto.randomUUID(), draftVersion: 0, lineItems: [] },
      }),
      state: unknown = created.json();
    expect(created.statusCode).toBe(201);
    if (typeof state !== 'object' || state === null || !('id' in state))
      throw new Error('Invalid fixture checkout');
    const forged = await app.inject({
      method: 'PUT',
      url: base + '/' + String(state.id) + '/wallet',
      payload: {
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        money: true,
        points: false,
        custom: true,
        appliedMoney: '1.00',
        is_verified: true,
      },
    });
    expect(forged.statusCode).toBe(400);
  });
  it('does not expose customer JWTs or upstream tokens in live or replayed cart responses', async () => {
    const created = await app.inject({
        method: 'POST',
        url: base,
        payload: { counterId: '3', draftId: crypto.randomUUID(), draftVersion: 0, lineItems: [] },
      }),
      body = created.json<{ id: string }>(),
      operation = { operationId: crypto.randomUUID(), expectedVersion: 0, quantity: 1 },
      url = base + '/' + body.id + '/line-items/10';
    for (let index = 0; index < 2; index++) {
      const result = await app.inject({ method: 'PUT', url, payload: operation });
      expect(result.statusCode).toBe(200);
      expect(result.body).not.toContain('private-api-token');
      expect(result.body).not.toContain('operatorCustomerId');
      expect(result.body).not.toContain('paymentConfirmation');
    }
  });
  it('validates payment boundaries before reaching a database or provider', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/stores/1/orders/8001/payment-attempts',
      payload: {
        operationId: crypto.randomUUID(),
        channel: 'cash',
        cashAmount: '-1.00',
        onlineAmount: '0.00',
        cashReceived: '0.00',
      },
    });
    expect(result.statusCode).toBe(400);
  });
});
