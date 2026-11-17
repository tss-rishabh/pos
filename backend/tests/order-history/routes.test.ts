import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import type { OrdersService } from '../../src/modules/orders.js';
import { registerPublicOrders } from '../../src/modules/order-history/routes.js';

const user: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'operator@example.test',
  role: 1,
  userType: 1,
  storeIds: ['2'],
};
const apps: ReturnType<typeof Fastify>[] = [];
async function fixture() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const orders: OrdersService = {
    list: vi.fn(async () => ({ data: [], nextCursor: null })),
    detail: vi.fn(async () => ({
      id: 9007199254740993n,
      reference: 'Fixture',
      amount: 12.5,
      createdAt: '2026-11-01 10:00:00',
      status: 'Paid',
      isPaid: true,
      lines: [
        {
          id: 9007199254740994n,
          productId: 9007199254740995n,
          name: 'Fixture product',
          quantity: 2n,
          amount: 6.25,
          gst: 0,
          status: 'Packed',
        },
      ],
    })),
  };
  const session = { authenticated: true, current: true, available: true };
  app.decorateRequest('principal', null);
  app.decorateRequest('authSessionValid', null);
  app.addHook('preHandler', async (request) => {
    if (session.authenticated) request.principal = user;
    if (session.available) request.authSessionValid = async () => session.current;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ code: error.code });
    if (error instanceof ZodError) return reply.code(400).send({ code: 'INVALID_INPUT' });
    return reply.code(500).send({ code: 'UNEXPECTED_ERROR' });
  });
  registerPublicOrders(app, orders);
  await app.ready();
  return { app, orders, session };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('public order HTTP integration', () => {
  it('accepts historical selection and opaque cursors and forwards the complete request scope', async () => {
    const { app, orders } = await fixture();
    const response = await app.inject({
      url: '/api/v1/stores/2/orders?from=2026-11-01&to=2026-11-02&intent=report&before=opaque.cursor-value&limit=50',
    });
    expect(response.statusCode).toBe(200);
    expect(orders.list).toHaveBeenCalledWith(user, '2', 'opaque.cursor-value', 50, {
      from: '2026-11-01',
      to: '2026-11-02',
      intent: 'report',
    });
  });
  it('keeps order, product and association IDs exact in selected historical detail', async () => {
    const { app, orders } = await fixture();
    const response = await app.inject({
      url: '/api/v1/stores/2/orders/9007199254740993?from=2026-11-01&to=2026-11-01',
    });
    expect(response.statusCode).toBe(200);
    expect(orders.detail).toHaveBeenCalledWith(user, '2', '9007199254740993', {
      from: '2026-11-01',
      to: '2026-11-01',
      intent: 'interactive',
    });
    expect(response.json()).toMatchObject({
      id: '9007199254740993',
      lines: [{ id: '9007199254740994', productId: '9007199254740995', quantity: '2' }],
    });
  });
  it('rejects incomplete dates and unknown fields before reading any order facts', async () => {
    const { app, orders } = await fixture();
    for (const suffix of [
      '?from=2026-11-01',
      '?to=2026-11-01',
      '?search=private-value',
      '?limit=101',
    ]) {
      expect((await app.inject({ url: '/api/v1/stores/2/orders' + suffix })).statusCode).toBe(400);
    }
    expect(
      (await app.inject({ url: '/api/v1/stores/2/orders/1?from=2026-11-01' })).statusCode,
    ).toBe(400);
    expect(orders.list).not.toHaveBeenCalled();
    expect(orders.detail).not.toHaveBeenCalled();
  });
  it('rejects unsigned requests before the service is called', async () => {
    const { app, orders, session } = await fixture();
    session.authenticated = false;
    expect((await app.inject({ url: '/api/v1/stores/2/orders' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/stores/2/orders/1' })).statusCode).toBe(401);
    expect(orders.list).not.toHaveBeenCalled();
    expect(orders.detail).not.toHaveBeenCalled();
  });
  it('withholds a completed list when its original session was revoked while awaiting facts', async () => {
    const { app, orders, session } = await fixture();
    vi.mocked(orders.list).mockImplementationOnce(async () => {
      session.current = false;
      return {
        data: [
          {
            id: '1',
            reference: 'PRIVATE_RESULT_CANARY',
            storeId: '2',
            customer: 'PRIVATE_CUSTOMER_CANARY',
            amount: '1',
            status: 'Paid',
            paymentStatus: 'Paid',
            createdAt: '2026-11-01 10:00:00',
          },
        ],
        nextCursor: null,
      };
    });
    const response = await app.inject({ url: '/api/v1/stores/2/orders' });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('PRIVATE_');
  });
  it('withholds detail when the session expires and fails closed without a session validator', async () => {
    const { app, orders, session } = await fixture();
    const detail = await orders.detail(user, '2', '1');
    vi.mocked(orders.detail)
      .mockClear()
      .mockImplementationOnce(async () => {
        session.current = false;
        return detail;
      });
    expect((await app.inject({ url: '/api/v1/stores/2/orders/1' })).statusCode).toBe(401);
    session.current = true;
    session.available = false;
    expect((await app.inject({ url: '/api/v1/stores/2/orders/1' })).statusCode).toBe(401);
  });
});
