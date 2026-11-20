import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noQuery, routeSchema, transportHeaders } from '../domain/route-validation.js';
import { clientEventIds, type RegisteredEvent } from './event-registry.js';

export const CLIENT_ERROR_PATH = '/api/v1/diagnostics/ui-errors';

/**
 * The ID-only UI error report: the registered event, the error's class name and the route
 * pattern. Never a message, stack, component props or query values. Same schema as
 * `frontend/src/observability/ui-events.ts`.
 */
export const clientErrorReport = z.strictObject({
  eventId: z.enum(clientEventIds),
  errorName: z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/),
  route: z
    .string()
    .regex(/^\/(?:(?:[a-z][a-z0-9-]{0,39}|:id)(?:\/:id){0,7})?$/)
    .max(128),
});
export type ClientErrorReport = z.infer<typeof clientErrorReport>;

/**
 * Web beacon for renderer errors (desktop reports over IPC to its own log instead).
 *
 * - Public, so a failure before sign-in is still reported; a signed-in caller's user ID is
 *   recorded. The first-party Origin check and S50 still apply.
 * - Rate-limited per client and capped at 1 KB.
 * - The strict schema accepts only the fixed fields above, so nothing else can reach the log.
 */
export function registerClientErrorReports(app: FastifyInstance) {
  app.post(
    CLIENT_ERROR_PATH,
    {
      bodyLimit: 1024,
      config: {
        trace: { module: 'diagnostics', resource: 'ui-error', action: 'report' },
        authentication: 'public',
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      ...routeSchema({ body: clientErrorReport, querystring: noQuery, headers: transportHeaders }),
    },
    async (request, reply) => {
      const report = clientErrorReport.parse(request.body);
      app.log.warn(
        {
          eventId: report.eventId,
          process: 'renderer',
          errorName: report.errorName,
          route: report.route,
        } satisfies RegisteredEvent,
        'User interface error reported',
      );
      return reply.code(204).send();
    },
  );
}
