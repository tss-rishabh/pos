import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { registerOriginHistoryBridge } from './history-routes.js';

export interface OriginHistoryBridgeEvent {
  module: 'screening-origins';
  resource: 'customer-history' | 'history-bridge-runtime';
  eventId: string;
  eventInstanceId: string;
  timestamp: string;
  requestId: string;
  userId: string | null;
  method: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}

/** Build a private service without opening a listener, database or SDK client.
 * Source proofs are checked by the registered reader before warehouse access.
 * No cookies, headers, URL values, bodies, SQL or raw errors enter these logs. */
export async function createOriginHistoryBridge(options: {
  sourceKey: string;
  history: Parameters<typeof registerOriginHistoryBridge>[2];
  clock?: () => number;
  observe?: (event: OriginHistoryBridgeEvent) => void;
}) {
  if (!/^[!-~]{32,4096}$/.test(options.sourceKey))
    throw new AppError(
      503,
      'SCREENING_ORIGIN_HISTORY_CONFIGURATION',
      'History service unavailable.',
    );
  const errors = new WeakMap<FastifyRequest, string>();
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 32000,
    requestTimeout: 30000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    maxRequestsPerSocket: 100,
    genReqId(request) {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && z.uuid().safeParse(supplied).success
        ? supplied
        : randomUUID();
    },
  });
  app.decorateRequest('auditUserId', null);
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Request-ID', request.id);
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: 'SCREENING_ORIGIN_HISTORY_ROUTE_NOT_FOUND',
      requestId: request.id,
    }),
  );
  app.setErrorHandler((error, request, reply) => {
    const frameworkStatus =
      error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 0;
    const status =
      error instanceof AppError && error.status >= 400 && error.status <= 599
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : [400, 413, 415].includes(frameworkStatus)
            ? frameworkStatus
            : 503;
    const code =
      error instanceof AppError && /^SCREENING_ORIGIN_[A-Z_]{1,80}$/.test(error.code)
        ? error.code
        : status < 500
          ? 'SCREENING_ORIGIN_HISTORY_REQUEST_INVALID'
          : 'SCREENING_ORIGIN_HISTORY_UNAVAILABLE';
    errors.set(request, code);
    return reply.code(status).header('Cache-Control', 'private, no-store').send({
      code,
      requestId: request.id,
    });
  });
  app.addHook('onResponse', async (request, reply) => {
    const action = request.routeOptions.config.trace?.action ?? 'handle';
    const resource =
      request.routeOptions.config.trace?.resource === 'history-bridge-runtime'
        ? 'history-bridge-runtime'
        : 'customer-history';
    const code = errors.get(request);
    try {
      options.observe?.({
        module: 'screening-origins',
        resource,
        eventId: `screening-origins.${resource}.${action}.${reply.statusCode >= 400 ? 'failed' : 'completed'}`,
        eventInstanceId: randomUUID(),
        timestamp: new Date().toISOString(),
        requestId: request.id,
        userId: request.auditUserId ?? null,
        method: request.method,
        status: reply.statusCode,
        durationMs: Number.isFinite(reply.elapsedTime)
          ? Math.round(reply.elapsedTime * 100) / 100
          : 0,
        ...(code ? { errorCode: code } : {}),
      });
    } catch {
      /* An unavailable log sink cannot change the authenticated response. */
    }
  });
  await registerOriginHistoryBridge(app, options.sourceKey, options.history, options.clock);
  return app;
}
