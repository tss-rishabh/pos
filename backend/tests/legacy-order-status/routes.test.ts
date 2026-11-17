import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createDatabases } from '../../src/db/pools.js';
import { registerWholeOrderStatus } from '../../src/modules/legacy-order-status/index.js';
import { wholeOrderStatusService } from '../../src/modules/legacy-order-status/service.js';
import { sourceStatusPresentation } from '../../src/modules/legacy-order-status/domain.js';
import { config, options, command, queuedReceipt } from './fixtures.js';
describe('current session guards around public status commands', () => {
  it.each(['before', 'after'] as const)('rejects revocation %s service work', async (when) => {
    const db = createDatabases(config),
      app = Fastify({ logger: false });
    let valid = when !== 'before';
    const service = wholeOrderStatusService(config, db, options, {
      transport: {
        configured() {},
        async send() {
          return queuedReceipt();
        },
        async read() {
          return queuedReceipt();
        },
      },
    });
    service.status = vi.fn(async () => {
      valid = false;
      return {
        orderId: command.orderId,
        storeId: '1',
        scopeHash: command.scopeHash,
        eligible: true,
        adapterReady: true,
        stages: sourceStatusPresentation([]),
        commands: [],
      };
    });
    const submit = vi.spyOn(service, 'submit');
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
      request.authSessionValid = async () => valid;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : 500,
        )
        .send({ error: { code: 'SESSION_EXPIRED', message: 'Sign in again to continue.' } }),
    );
    await registerWholeOrderStatus(app, config, db, options, { service });
    try {
      const response =
        when === 'before'
          ? await app.inject({
              method: 'POST',
              url: '/api/v1/stores/1/orders/' + command.orderId + '/status-requests',
              payload: { operationId: command.id, scopeHash: command.scopeHash, platform: 'PACK' },
            })
          : await app.inject({
              url: '/api/v1/stores/1/orders/' + command.orderId + '/fulfillment-status',
            });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(command.orderId);
      expect(submit).not.toHaveBeenCalled();
      expect(service.status).toHaveBeenCalledTimes(when === 'after' ? 1 : 0);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
