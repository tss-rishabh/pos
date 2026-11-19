import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { exportInputSchema } from './export-domain.js';
import { exportListInputSchema, type ReportExportService } from './export-service.js';
const trace = (action: string) => ({
  trace: { module: 'operational-reports', resource: 'report-export', action },
});
export async function registerReportExportRoutes(
  app: FastifyInstance,
  service: Pick<ReportExportService, 'create' | 'list' | 'download'>,
) {
  /** Legacy `is_export` POSTs (E1-E6): validate, enqueue, return the legacy message. */
  app.post('/api/v1/report-exports', { config: trace('create') }, async (request) => {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign back in before continuing.',
      );
    const body = z.object({ input: exportInputSchema }).strict().parse(request.body);
    return service.create(user, body.input);
  });
  app.get('/api/v1/report-exports', { config: trace('list') }, async (request) =>
    service.list(
      authenticated(request),
      exportListInputSchema.omit({ search: true }).parse(request.query),
    ),
  );
  app.post('/api/v1/report-exports/search', { config: trace('search') }, async (request) =>
    service.list(authenticated(request), exportListInputSchema.parse(request.body)),
  );
  app.get(
    '/api/v1/report-exports/:exportId/file',
    { config: trace('download') },
    async (request, reply) => {
      const user = authenticated(request),
        params = z.object({ exportId: identifier }).strict().parse(request.params),
        controller = new AbortController(),
        abort = () => controller.abort();
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      try {
        const file = await service.download(user, params.exportId, controller.signal);
        file.body.once('error', abort);
        return reply
          .header('Cache-Control', 'private, no-store')
          .header('Content-Type', file.contentType)
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .header('Content-Length', file.size)
          .send(file.body);
      } catch (error) {
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abort);
        throw error;
      }
    },
  );
}
