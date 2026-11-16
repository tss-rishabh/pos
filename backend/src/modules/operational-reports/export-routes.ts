import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { exportInputSchema } from './export-domain.js';
import type { reportExportService } from './export-service.js';
import { exportHistoryInputSchema } from './export-history.js';
const trace = (action: string) => ({
  trace: { module: 'operational-reports', resource: 'report-export', action },
});
export async function registerReportExportRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof reportExportService>,
) {
  app.post('/api/v1/report-exports', { config: trace('create') }, async (request, reply) => {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign back in before continuing.',
      );
    const body = z
        .object({ commandId: z.uuid(), input: exportInputSchema })
        .strict()
        .parse(request.body),
      result = await service.create(user, body.commandId, body.input, request.id);
    return reply
      .code(result.status === 'COMPLETED' || result.status === 'FAILED' ? 200 : 202)
      .send(result);
  });
  app.get('/api/v1/report-exports', { config: trace('list') }, async (request) => {
    const user = authenticated(request),
      query = exportHistoryInputSchema.omit({ search: true }).parse(request.query);
    return service.list(user, { ...query, search: '' });
  });
  app.post('/api/v1/report-exports/search', { config: trace('search') }, async (request) =>
    service.list(authenticated(request), exportHistoryInputSchema.parse(request.body)),
  );
  app.get('/api/v1/report-exports/:exportId', { config: trace('read') }, async (request) => {
    const user = authenticated(request),
      params = z.object({ exportId: z.uuid() }).parse(request.params);
    return service.read(user, params.exportId);
  });
  async function download(request: FastifyRequest, reply: FastifyReply, legacy: boolean) {
    const user = authenticated(request),
      params = z.object({ exportId: legacy ? identifier : z.uuid() }).parse(request.params),
      controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const file = legacy
        ? await service.downloadLegacy(user, params.exportId, controller.signal)
        : await service.download(user, params.exportId, controller.signal);
      file.body.once('error', () => controller.abort());
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
  }
  app.get(
    '/api/v1/report-exports/:exportId/file',
    { config: trace('download') },
    (request, reply) => download(request, reply, false),
  );
  app.get(
    '/api/v1/report-exports/legacy/:exportId/file',
    { config: trace('download-legacy') },
    (request, reply) => download(request, reply, true),
  );
}
