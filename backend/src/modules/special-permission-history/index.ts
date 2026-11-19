import type { FastifyInstance } from 'fastify';
import type { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import { activitySearchInput, type SpecialPermissionHistoryOptions } from './contracts.js';
import { specialPermissionHistoryService, type ActivityWarehouse } from './service.js';

export { readSpecialPermissionHistoryOptions } from './contracts.js';
export { specialPermissionHistoryService } from './service.js';
export function registerSpecialPermissionHistory(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options?: SpecialPermissionHistoryOptions,
  warehouse?: ActivityWarehouse,
  clock?: () => Temporal.Instant,
) {
  const service = specialPermissionHistoryService(config, db, options, warehouse, clock),
    trace = {
      config: {
        trace: {
          module: 'special-permission-history',
          resource: 'special-permission-activity',
          action: 'read',
        },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    };
  app.get(
    '/api/v1/admin/special-permission-activity/capabilities',
    { ...trace, ...routeSchema({ querystring: noQuery, headers: transportHeaders }) },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.capabilities(authenticated(request)));
    },
  );
  app.post(
    '/api/v1/admin/special-permission-activity/search',
    {
      ...trace,
      ...routeSchema({
        querystring: noQuery,
        body: activitySearchInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.search(authenticated(request), activitySearchInput.parse(request.body)),
        );
    },
  );
  return service;
}
