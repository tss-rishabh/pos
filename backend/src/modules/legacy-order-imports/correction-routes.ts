import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import {
  importCorrectionContract,
  importCorrectionInputSchema,
  type ImportCorrectionBoundaryPort,
} from './correction-contracts.js';
import { legacyOrderImportCorrections } from './correction-repository.js';
export { legacyOrderImportCorrections } from './correction-repository.js';

export function readImportCorrectionOptions(env: NodeJS.ProcessEnv = process.env) {
  const optional = <T extends z.ZodType>(schema: T) =>
    z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
  return z
    .object({
      LEGACY_ORDER_IMPORT_CORRECTION_CONTRACT: optional(z.literal(importCorrectionContract)),
      LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: optional(z.string().regex(/^[!-~]{32,4096}$/)),
    })
    .parse(env);
}
export interface ImportCorrectionRegistrationOptions {
  runtime?: ReturnType<typeof readImportCorrectionOptions>;
  boundary?: ImportCorrectionBoundaryPort;
  clock?: () => number;
  service?: ReturnType<typeof legacyOrderImportCorrections>;
}
export function registerLegacyOrderImportCorrections(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: ImportCorrectionRegistrationOptions = {},
) {
  const runtime =
      options.runtime ?? readImportCorrectionOptions(config.DEMO_MODE ? {} : process.env),
    secret = runtime.LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1,
    service =
      options.service ??
      (secret
        ? legacyOrderImportCorrections(db, config, {
            secret,
            contract: runtime.LEGACY_ORDER_IMPORT_CORRECTION_CONTRACT,
            boundary: options.boundary,
            clock: options.clock,
          })
        : null),
    scope = z.object({ jobId: z.uuid(), operationId: z.uuid() }).strict(),
    empty = z.object({}).strict(),
    base = '/api/v1/admin/order-imports/:jobId/orders/:operationId/corrections',
    trace = (action: string) => ({
      bodyLimit: 128000,
      config: {
        trace: { module: 'administration', resource: 'order-import-correction', action },
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    });
  async function session(request: FastifyRequest) {
    const user = authenticated(request);
    if (!request.authSessionId || !request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    if (!service)
      throw new AppError(
        503,
        'ORDER_IMPORT_CORRECTION_DISABLED',
        'Import correction recovery is not configured.',
      );
    return { user, sessionId: request.authSessionId, service };
  }
  app.get(base, trace('review'), async (request, reply) => {
    empty.parse(request.query);
    const { jobId, operationId } = scope.parse(request.params),
      auth = await session(request),
      result = await auth.service.review(auth.user, jobId, operationId, auth.sessionId);
    await session(request);
    return reply.header('Cache-Control', 'private, no-store').send(result);
  });
  app.post(base, trace('create'), async (request, reply) => {
    empty.parse(request.query);
    const { jobId, operationId } = scope.parse(request.params),
      body = importCorrectionInputSchema.parse(request.body),
      auth = await session(request),
      result = await auth.service.create(
        auth.user,
        jobId,
        operationId,
        body,
        auth.sessionId,
        request.id,
      );
    await session(request);
    return reply.code(202).header('Cache-Control', 'private, no-store').send(result);
  });
  app.get(base + '/:correctionId', trace('recovery'), async (request, reply) => {
    empty.parse(request.query);
    const { jobId, operationId, correctionId } = scope
        .extend({ correctionId: z.uuid() })
        .parse(request.params),
      auth = await session(request),
      result = await auth.service.readCommand(
        auth.user,
        jobId,
        operationId,
        correctionId,
        auth.sessionId,
        request.id,
      );
    await session(request);
    return reply.header('Cache-Control', 'private, no-store').send(result);
  });
  return service;
}
