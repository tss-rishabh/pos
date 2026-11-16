import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { barcodeAssignmentService } from './service.js';
export { barcodeAssignmentService } from './service.js';
export function registerBarcodeAssignments(app: FastifyInstance, config: Config, db: Databases) {
  const service = barcodeAssignmentService(config, db),
    trace = (action: string) => ({
      config: {
        trace: { module: 'administration', resource: 'barcode-assignment', action },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    });
  app.post('/api/v1/admin/barcode-assignments', trace('create'), async (request, reply) => {
    z.object({}).strict().parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.assign(authenticated(request), request.body));
  });
  app.get(
    '/api/v1/admin/barcode-assignments/:operationId',
    trace('read'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const { operationId } = z.object({ operationId: z.uuid() }).strict().parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.get(authenticated(request), operationId));
    },
  );
  return service;
}
