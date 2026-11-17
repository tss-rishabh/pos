import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import {
  importJobId,
  importKindInput,
  importResultsInput,
  importResumptionInput,
} from './domain.js';
import { legacyImportInputSchema } from './preparation.js';
import { registerLegacyOrderImportCorrections } from './correction-routes.js';
import { legacyOrderImportService, type LegacyOrderImportRegistrationOptions } from './service.js';
export { legacyOrderImportService, type LegacyOrderImportRegistrationOptions } from './service.js';
export { readLegacyOrderImportOptions } from './options.js';

export function registerLegacyOrderImports(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: LegacyOrderImportRegistrationOptions = {},
) {
  registerLegacyOrderImportCorrections(app, config, db, {
    runtime: {
      LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: options.runtime?.LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1,
    },
    service: options.corrections,
  });
  const service = legacyOrderImportService(config, db, options),
    base = '/api/v1/admin/order-imports',
    empty = z.object({}).strict(),
    trace = (action: string) => ({
      bodyLimit: 11 * 1024 * 1024,
      config: {
        trace: { module: 'administration', resource: 'historical-order-import', action },
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    });
  async function session(request: FastifyRequest) {
    const user = authenticated(request);
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return user;
  }
  async function respond<T>(request: FastifyRequest, task: () => Promise<T>) {
    const result = await task();
    await session(request);
    return result;
  }
  app.get(base + '/capabilities', trace('capabilities'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await respond(request, () => service.capabilities(user)));
  });
  app.get(base + '/templates/:kind', trace('template'), async (request, reply) => {
    empty.parse(request.query);
    const { kind } = importKindInput.parse(request.params),
      user = await session(request);
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="${kind}-orders-template.csv"`)
      .type('text/csv; charset=utf-8')
      .send(await respond(request, () => service.template(user, kind)));
  });
  app.post(base + '/previews', trace('preview'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request),
      body = legacyImportInputSchema.parse(request.body);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await respond(request, () => service.preview(user, body)));
  });
  app.post(base, trace('create'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request),
      body = legacyImportInputSchema.parse(request.body);
    return reply
      .header('Cache-Control', 'private, no-store')
      .code(202)
      .send(await respond(request, () => service.stage(user, request.id, body)));
  });
  app.get(base + '/:jobId', trace('read'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request),
      { jobId } = importJobId.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await respond(request, () => service.detail(user, jobId)));
  });
  app.get(base + '/:jobId/results', trace('results'), async (request, reply) => {
    const user = await session(request),
      { jobId } = importJobId.parse(request.params),
      query = importResultsInput.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await respond(request, () => service.results(user, jobId, query.after, query.limit)));
  });
  app.post(base + '/:jobId/cancellations', trace('cancel'), async (request, reply) => {
    empty.parse(request.query);
    empty.parse(request.body ?? {});
    const user = await session(request),
      { jobId } = importJobId.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await respond(request, () => service.cancel(user, jobId)));
  });
  app.post(base + '/:jobId/resumptions', trace('resume'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request),
      { jobId } = importJobId.parse(request.params),
      { operationId } = importResumptionInput.parse(request.body);
    return reply
      .header('Cache-Control', 'private, no-store')
      .code(202)
      .send(await respond(request, () => service.resume(user, jobId, operationId, request.id)));
  });
  app.get(
    base + '/:jobId/resumptions/:operationId',
    trace('resume-read'),
    async (request, reply) => {
      empty.parse(request.query);
      const user = await session(request),
        { jobId, operationId } = importJobId
          .extend({ operationId: z.uuid() })
          .parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await respond(request, () => service.readResumption(user, jobId, operationId)));
    },
  );
  const approvalScope = importJobId.extend({ operationId: z.uuid() }),
    approvalBase = base + '/:jobId/orders/:operationId/approvals';
  app.get(approvalBase, trace('approval-read'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request),
      { jobId, operationId } = approvalScope.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await respond(request, () => service.approval(user, jobId, operationId)));
  });
  app.get(approvalBase + '/:commandId', trace('approval-recovery'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request),
      { jobId, operationId, commandId } = approvalScope
        .extend({ commandId: z.uuid() })
        .parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await respond(request, () => service.approval(user, jobId, operationId, commandId)));
  });
  app.post(approvalBase, trace('approval-create'), async (request, reply) => {
    empty.parse(request.query);
    const user = await session(request),
      { jobId, operationId } = approvalScope.parse(request.params),
      body = z
        .object({
          commandId: z.uuid(),
          reason: z.enum(['late-recording', 'historical-correction', 'source-reconciliation']),
        })
        .strict()
        .parse(request.body);
    return reply
      .header('Cache-Control', 'private, no-store')
      .code(201)
      .send(await respond(request, () => service.requestApproval(user, jobId, operationId, body)));
  });
  return service;
}
