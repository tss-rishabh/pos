import type { FastifyInstance } from 'fastify';
import type { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { historyInput, type AdministrationHistoryOptions } from './contracts.js';
import { administrationHistoryService, type AdministrationHistoryWarehouse } from './service.js';

export { readAdministrationHistoryOptions } from './contracts.js';
export { administrationHistoryService } from './service.js';
export function registerAdministrationHistory(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options?: AdministrationHistoryOptions,
  warehouse?: AdministrationHistoryWarehouse,
  clock?: () => Temporal.Instant,
) {
  const service = administrationHistoryService(config, db, options, warehouse, clock);
  const trace = {
    config: {
      trace: { module: 'administration-history', resource: 'model-history', action: 'read' },
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  };
  app.get('/api/v1/admin/model-history/capabilities', trace, async (request, reply) => {
    z.object({}).strict().parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.capabilities(authenticated(request)));
  });
  app.post('/api/v1/admin/model-history/search', trace, async (request, reply) => {
    z.object({}).strict().parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.search(authenticated(request), historyInput.parse(request.body)));
  });
  return service;
}
