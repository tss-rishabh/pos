import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../../auth/routes.js';
import { AppError } from '../../../domain/errors.js';
import {
  successionApproveInputSchema,
  successionContinueInputSchema,
  type ImportAuthoritySuccessionPort,
} from './contracts.js';
export function registerLegacyImportAuthoritySuccession(
  app: FastifyInstance,
  options: { service?: ImportAuthoritySuccessionPort } = {},
) {
  const base = '/api/v1/admin/order-imports/:jobId/orders/:operationId/authority-successions',
    scope = z.object({ jobId: z.uuid(), operationId: z.uuid() }).strict(),
    empty = z.object({}).strict();
  const trace = (action: string) => ({
    bodyLimit: 16000,
    config: {
      trace: { module: 'administration', resource: 'import-authority-succession', action },
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  });
  async function session(request: FastifyRequest) {
    const user = authenticated(request);
    if (!request.authSessionId || !request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    if (!options.service)
      throw new AppError(
        503,
        'ORDER_IMPORT_SUCCESSION_DISABLED',
        'Existing-order authority recovery is not configured.',
      );
    return { user, id: request.authSessionId, service: options.service };
  }
  app.get(base, trace('review'), async (request, reply) => {
    empty.parse(request.query);
    const input = scope.parse(request.params),
      auth = await session(request),
      value = await auth.service.review(auth.user, input.jobId, input.operationId, auth.id);
    await session(request);
    return reply.header('Cache-Control', 'private, no-store').send(value);
  });
  app.post(base, trace('approve'), async (request, reply) => {
    empty.parse(request.query);
    const input = scope.parse(request.params),
      body = successionApproveInputSchema.parse(request.body),
      auth = await session(request),
      value = await auth.service.approve(
        auth.user,
        input.jobId,
        input.operationId,
        body,
        auth.id,
        request.id,
      );
    await session(request);
    return reply.code(201).header('Cache-Control', 'private, no-store').send(value);
  });
  app.get(base + '/:commandId', trace('approval-read'), async (request, reply) => {
    empty.parse(request.query);
    const input = scope.extend({ commandId: z.uuid() }).parse(request.params),
      auth = await session(request),
      value = await auth.service.readApproval(
        auth.user,
        input.jobId,
        input.operationId,
        input.commandId,
        auth.id,
      );
    await session(request);
    return reply.header('Cache-Control', 'private, no-store').send({ data: value });
  });
  app.post(base + '/continuations', trace('continue'), async (request, reply) => {
    empty.parse(request.query);
    const input = scope.parse(request.params),
      body = successionContinueInputSchema.parse(request.body),
      auth = await session(request),
      value = await auth.service.continue(
        auth.user,
        input.jobId,
        input.operationId,
        body,
        auth.id,
        request.id,
      );
    await session(request);
    return reply.code(202).header('Cache-Control', 'private, no-store').send(value);
  });
  app.get(
    base + '/continuations/:commandId',
    trace('continuation-read'),
    async (request, reply) => {
      empty.parse(request.query);
      const input = scope.extend({ commandId: z.uuid() }).parse(request.params),
        auth = await session(request),
        value = await auth.service.readContinuation(
          auth.user,
          input.jobId,
          input.operationId,
          input.commandId,
          auth.id,
        );
      await session(request);
      return reply.header('Cache-Control', 'private, no-store').send({ data: value });
    },
  );
}
