import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import { registerInvoiceDocuments } from '../../src/modules/invoice-documents/index.js';
it('rejects stale actors, unsafe IDs and legacy bypass parameters before any database access', async () => {
  const app = Fastify(),
    get = vi.fn(() => {
      throw new Error('Unexpected database access');
    }),
    db = { get } as unknown as Databases;
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (request) => {
    request.principal = {
      id: '7',
      role: 4,
      userType: 1,
      storeIds: ['1'],
      name: 'Fixture',
      email: 'fixture@example.test',
    };
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .status(
        (error as { statusCode?: number; status?: number }).statusCode ??
          (error as { status?: number }).status ??
          400,
      )
      .send({ error: true }),
  );
  registerInvoiceDocuments(
    app,
    readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'fixture-invoice-key-'.repeat(4),
    }),
    db,
    {},
  );
  for (const [url, operator] of [
    ['/api/v1/stores/1/orders/3/invoices/online', '8'],
    ['/api/v1/stores/1/orders/3/invoices/capabilities', '8'],
    ['/api/v1/stores/1/orders/3/invoices/express?has_product_ids=1', '7'],
    ['/api/v1/operators/8/stores/1/orders/3/invoices/express/preview', '7'],
    ['/api/v1/operators/7/stores/1/orders/3/invoices/same-day/preview?pos_token=CANARY', '7'],
    ['/api/v1/stores/1/orders/9223372036854775808/invoices/online', '7'],
    ['/api/v1/stores/1/orders/3/invoices/online?cr=1&is_hl=1', '7'],
    ['/api/v1/operators/8/stores/1/orders/3/invoices/store/preview', '7'],
    ['/api/v1/operators/7/stores/1/orders/3/invoices/store/preview', '8'],
    ['/api/v1/operators/7/stores/1/orders/3/invoices/unknown/preview', '7'],
    ['/api/v1/operators/7/stores/1/orders/3/invoices/store/preview?cr=1', '7'],
  ] as const) {
    const response = await app.inject({ url, headers: { 'x-operator-id': operator } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }
  expect(get).not.toHaveBeenCalled();
  await app.close();
});
