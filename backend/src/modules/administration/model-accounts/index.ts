import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { modelAccountInput } from './domain.js';
import { operatorModelAccountService } from './service.js';
export { operatorModelAccountService } from './service.js';
export function registerOperatorModelAccounts(app: FastifyInstance, config: Config, db: Databases) {
  const service = operatorModelAccountService(config, db),
    base = '/api/v1/admin/operator-model-accounts',
    none = z.object({}).strict(),
    trace = (action: string) => ({
      config: {
        trace: { module: 'administration', resource: 'operator-model-account', action },
        rateLimit: { max: action === 'create' ? 5 : 60, timeWindow: '1 minute' },
      },
    });
  app.get(base + '/capabilities', trace('capabilities'), async (request, reply) => {
    none.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.capabilities(authenticated(request)));
  });
  app.post(base, trace('create'), async (request, reply) => {
    none.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.create(authenticated(request), modelAccountInput.parse(request.body)));
  });
  app.get(base + '/:operationId', trace('read'), async (request, reply) => {
    none.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(
        await service.read(
          authenticated(request),
          z.object({ operationId: z.uuid() }).strict().parse(request.params).operationId,
        ),
      );
  });
  return service;
}
