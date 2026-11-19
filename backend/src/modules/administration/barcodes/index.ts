import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import type { EphemeralStore } from '../../../jobs/ephemeral.js';
import { noQuery, routeSchema, transportHeaders } from '../../../domain/route-validation.js';
import { barcodeAssignmentInput } from './domain.js';
import { barcodeAssignmentService } from './service.js';
export { barcodeAssignmentService } from './service.js';
const operationScope = z.object({ operationId: z.uuid() }).strict();
export function registerBarcodeAssignments(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  ephemeral: EphemeralStore,
) {
  const service = barcodeAssignmentService(config, db, ephemeral),
    trace = (action: string) => ({
      config: {
        trace: { module: 'administration', resource: 'barcode-assignment', action },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    });
  app.post(
    '/api/v1/admin/barcode-assignments',
    {
      ...trace('create'),
      ...routeSchema({
        querystring: noQuery,
        body: barcodeAssignmentInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.assign(authenticated(request), request.body));
    },
  );
  app.get(
    '/api/v1/admin/barcode-assignments/:operationId',
    {
      ...trace('read'),
      ...routeSchema({ params: operationScope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      const { operationId } = operationScope.parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.get(authenticated(request), operationId));
    },
  );
  return service;
}
