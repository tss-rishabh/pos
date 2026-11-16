import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { secretMatches } from '../fulfillment/options.js';
import { scheduleInput } from './scheduled-domain.js';
import type { scheduledReportService } from './scheduled-service.js';
import type { ScheduledReportOptions } from './scheduled-options.js';
export async function registerScheduledReportRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof scheduledReportService>,
  options: ScheduledReportOptions,
) {
  const auth = {
    config: {
      authentication: 'service' as const,
      trace: {
        module: 'operational-reports',
        resource: 'scheduled-report-delivery',
        action: 'create',
      },
    },
    preValidation: async (request: FastifyRequest) => {
      if (!secretMatches(options.REPORTS_API_KEY, request.headers['x-api-key']))
        throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Invalid or missing API key');
    },
  };
  app.post('/api/v1/report-deliveries', auth, async (request, reply) => {
    const body = z
      .object({ commandId: z.uuid(), input: scheduleInput })
      .strict()
      .parse(request.body);
    return reply.code(202).send(await service.create(body.commandId, body.input, request.id));
  });
  app.get(
    '/api/v1/report-deliveries/:jobId',
    { ...auth, config: { ...auth.config, trace: { ...auth.config.trace, action: 'read' } } },
    async (request) => service.read(z.object({ jobId: z.uuid() }).parse(request.params).jobId),
  );
  app.post(
    '/api/v1/report-deliveries/:jobId/targets/:targetId/reconciliation',
    { ...auth, config: { ...auth.config, trace: { ...auth.config.trace, action: 'reconcile' } } },
    async (request) => {
      const params = z.object({ jobId: z.uuid(), targetId: z.uuid() }).parse(request.params),
        body = z
          .object({ commandId: z.uuid(), outcome: z.enum(['delivered', 'not-delivered']) })
          .strict()
          .parse(request.body);
      return service.reconcile(params.jobId, params.targetId, body.commandId, body.outcome);
    },
  );
}
