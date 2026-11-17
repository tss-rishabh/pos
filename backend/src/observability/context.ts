import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import type {} from '../fastify-extensions.js';

export interface RequestTraceContext {
  requestId: string;
  userId: string | null;
  module: string;
  resource: string;
}
const storage = new AsyncLocalStorage<Readonly<RequestTraceContext>>();

/** Reuse an initiating request's identifiers when a durable job runs later. */
export function withRequestTrace<T>(trace: Readonly<RequestTraceContext>, task: () => T): T {
  return storage.run(
    {
      requestId: trace.requestId,
      userId: trace.userId,
      module: trace.module,
      resource: trace.resource,
    },
    task,
  );
}

/** Snapshot identifiers only; callers cannot obtain the request, payload or credentials. */
export function currentRequestTrace(): RequestTraceContext | null {
  const context = storage.getStore();
  return context
    ? {
        requestId: context.requestId,
        userId: context.userId,
        module: context.module,
        resource: context.resource,
      }
    : null;
}
export function registerRequestTrace(app: FastifyInstance) {
  app.addHook('onRequest', (request, _reply, done) => {
    const trace = request.routeOptions.config.trace || {
      module: 'system',
      resource: 'http-request',
    };
    storage.run(
      {
        requestId: request.id,
        module: trace.module,
        resource: trace.resource,
        get userId() {
          return request.principal?.id || request.auditUserId || null;
        },
      },
      done,
    );
  });
}
