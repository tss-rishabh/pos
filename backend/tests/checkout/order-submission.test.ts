import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { checkoutGateway } from '../../src/modules/checkout/gateway.js';
import { checkoutService } from '../../src/modules/checkout/service.js';
import { MemoryCheckoutRepository, operator, signingEnvironment } from './fixtures.js';

/**
 * A fake, unpatched API-v2 (pinned behaviour): it accepts only the legacy headers, never echoes
 * customer-context proofs and answers pos/order with {order, method, isValid, name}.
 */
function fakeApiV2() {
  const requests: { path: string; headers: Record<string, string>; body: unknown }[] = [];
  const cart = {
    products: { items: [{ prod_id: 10, quantity: 1, prod_type: 1, price: 499 }] },
    giftvouchers: { items: [] },
    meta: { items: [{ name: 'calculations', total: 499 }] },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path: url.pathname, headers, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    switch (url.pathname) {
      case '/api/v2/cart':
      case '/api/v2/processorder':
        return json(cart);
      case '/api/v2/validatecheckout':
        return json({ valid: true });
      case '/api/v2/pos/order':
        return json({ order: 7001, method: 'coc', isValid: true, name: 'Fixture' });
      case '/payments/order':
        return json({ ok: true }, 201);
      default:
        return json({ title: 'Not found' }, 404);
    }
  };
  return { requests, fetcher };
}

describe('pos/order against unpatched API-v2', () => {
  it('completes a normal sale with the legacy payload, headers and token', async () => {
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'order-submission-test-session-'.repeat(2),
      MYSQL_PRIMARY_READER_URL: 'mysql://user:pass@127.0.0.1:3306/db',
      TSS_API_BASE_URL: 'http://127.0.0.1:9/api/v2/',
    });
    const api = fakeApiV2();
    const environment = {
      ...signingEnvironment,
      paymentOrderUrl: 'http://127.0.0.1:9/payments/order',
    };
    const gateway = checkoutGateway(config, environment, api.fetcher);
    const repository = new MemoryCheckoutRepository();
    const finalized: { orderId: string; confirmed: boolean }[] = [];
    const salespersons: string[] = [];
    const service = checkoutService(repository, gateway, environment, {
      migrationV2: true,
      assertCheckIn: async () => {},
      recordLineSalespersons: async (_state, orderId) => {
        salespersons.push(orderId);
      },
      finalizeOrder: async (_state, orderId, outcome = { confirmed: true }) => {
        finalized.push({ orderId, confirmed: outcome.confirmed });
        return { transactionId: orderId, invoice: 'S0012627INV00001' };
      },
    });
    const created = await service.create(operator, '1', '3');
    repository.states.get(created.id)!.salespersonId = '5';
    await service.quote(operator, '1', created.id, {
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    });
    const done = await service.submit(operator, '1', created.id, {
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    expect(done.status).toBe('succeeded');
    if (done.status !== 'succeeded') throw new Error('expected success');
    expect(done.result).toMatchObject({ orderId: '7001', paymentStatus: 'pending' });
    expect(salespersons).toEqual(['7001']);
    expect(finalized).toEqual([{ orderId: '7001', confirmed: true }]);

    const order = api.requests.find((request) => request.path === '/api/v2/pos/order')!;
    // Exactly the legacy AjaxOrderView.order headers (order/views.py:2850-2853).
    expect(Object.keys(order.headers).sort()).toEqual(['authorization', 'content-type']);
    expect(order.headers['content-type']).toBe('application/json');
    expect(order.headers.authorization).not.toMatch(/^Bearer /);
    const claims = JSON.parse(
      Buffer.from(order.headers.authorization!.split('.')[1]!, 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(claims.sub).toBe('777');
    const state = repository.states.get(created.id)!;
    // Same keys, order and values as order/views.py:2863-2877; tab_id for a walk-in cart.
    expect(Object.keys(order.body as object)).toEqual([
      'payment_method',
      'is_pos',
      'store_id',
      'counter_id',
      'salesperson_id',
      'admin_user_id',
      'custom_data',
      'custom_created_at',
      'gc_data',
      'tab_id',
    ]);
    expect(order.body).toEqual({
      payment_method: 'coc',
      is_pos: true,
      store_id: 1,
      counter_id: 3,
      salesperson_id: 5,
      admin_user_id: 777,
      custom_data: null,
      custom_created_at: null,
      gc_data: {},
      tab_id: state.tabId,
    });
    const confirmation = api.requests.find((request) => request.path === '/payments/order')!;
    expect(Object.keys(confirmation.headers).sort()).toEqual(['authorization', 'content-type']);
    expect(confirmation.body).toEqual({
      order: 7001,
      method: 'coc',
      isValid: true,
      name: 'Fixture',
      is_pos: true,
      store_id: 1,
    });
    for (const request of api.requests)
      expect(Object.keys(request.headers).filter((name) => name.startsWith('x-'))).toEqual([]);
  });
});
