import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import { registerWholeOrderStatus } from '../../src/modules/legacy-order-status/index.js';
import { wholeOrderStatusService } from '../../src/modules/legacy-order-status/service.js';
import {
  sourceStatusPresentation,
  queuedMessage,
} from '../../src/modules/legacy-order-status/domain.js';
import { config, options } from './fixtures.js';

async function harness(valid: () => boolean) {
  const app = Fastify({ logger: false }),
    db = {} as Databases,
    service = wholeOrderStatusService(config, db, options, { callStatusApi: async () => 'sent' });
  service.status = vi.fn(async (_user, storeId, orderId) => ({
    orderId,
    storeId,
    processed: true,
    stages: sourceStatusPresentation([]),
  }));
  service.push = vi.fn(async () => ({ message: queuedMessage, outcome: 'sent' as const }));
  app.decorateRequest('principal', null);
  app.decorateRequest('authSessionValid', null);
  app.addHook('onRequest', async (request) => {
    request.principal = {
      id: '1',
      role: 2,
      userType: 1,
      storeIds: ['1'],
      name: 'Synthetic',
      email: '',
    };
    request.authSessionValid = async () => valid();
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        typeof error === 'object' && error !== null && 'status' in error
          ? Number(error.status)
          : 400,
      )
      .send({ error: 'rejected' }),
  );
  await registerWholeOrderStatus(app, config, db, options, { service });
  return { app, service };
}
describe('whole-order status routes', () => {
  it('rejects an expired session before any work', async () => {
    const { app, service } = await harness(() => false);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stores/1/orders/9/status-requests',
      payload: { platform: 'PACK' },
    });
    expect(response.statusCode).toBe(401);
    expect(service.push).not.toHaveBeenCalled();
    await app.close();
  });
  it('pushes a platform and answers the legacy message', async () => {
    const { app, service } = await harness(() => true);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stores/1/orders/9/status-requests',
      payload: { platform: 'SHIP' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: queuedMessage });
    expect(service.push).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1' }),
      '1',
      '9',
      'SHIP',
    );
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/stores/1/orders/9/status-requests',
      payload: { platform: 'RTO' },
    });
    expect(invalid.statusCode).toBe(400);
    const read = await app.inject({ url: '/api/v1/stores/1/orders/9/fulfillment-status' });
    expect(read.json()).toMatchObject({ orderId: '9', storeId: '1', processed: true });
    await app.close();
  });
});
