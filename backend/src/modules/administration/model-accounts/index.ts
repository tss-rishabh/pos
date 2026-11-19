import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../../domain/route-validation.js';
import { modelAccountInput } from './domain.js';
import { operatorModelAccountService } from './service.js';
export { operatorModelAccountService } from './service.js';
export function registerOperatorModelAccounts(app: FastifyInstance, config: Config, db: Databases) {
  const service = operatorModelAccountService(config, db),
    base = '/api/v1/admin/operator-model-accounts',
    none = noQuery,
    operationScope = z.object({ operationId: z.uuid() }).strict(),
    trace = (action: string) => ({
      config: {
        trace: { module: 'administration', resource: 'operator-model-account', action },
        rateLimit: { max: action === 'create' ? 5 : 60, timeWindow: '1 minute' },
      },
    });
  app.get(
    base + '/capabilities',
    { ...trace('capabilities'), ...routeSchema({ querystring: none, headers: transportHeaders }) },
    async (request, reply) => {
      none.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.capabilities(authenticated(request)));
    },
  );
  app.post(
    base,
    {
      ...trace('create'),
      ...routeSchema({ querystring: none, body: modelAccountInput, headers: transportHeaders }),
    },
    async (request, reply) => {
      none.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.create(authenticated(request), modelAccountInput.parse(request.body)));
    },
  );
  app.get(
    base + '/:operationId',
    {
      ...trace('read'),
      ...routeSchema({ params: operationScope, querystring: none, headers: transportHeaders }),
    },
    async (request, reply) => {
      none.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.read(
            authenticated(request),
            operationScope.parse(request.params).operationId,
          ),
        );
    },
  );
  return service;
}
