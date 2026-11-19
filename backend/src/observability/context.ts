import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {} from '../fastify-extensions.js';

export interface RequestTraceContext {
  /** Equal to `requestId`: one ID correlates the request, its jobs and its outbound calls. */
  traceId: string;
  requestId: string;
  userId: string | null;
  module: string;
  resource: string;
}
export type RequestTraceInput = Omit<RequestTraceContext, 'traceId'> & { traceId?: string };
const storage = new AsyncLocalStorage<Readonly<RequestTraceContext>>();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A trace/request ID: an inbound value is honoured only when it is a UUID (no log injection). */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
/** Fastify `genReqId`: reuse a caller's `X-Request-Id` UUID (retries, Electron sync), else new. */
export function requestIdFor(request: Pick<IncomingMessage, 'headers'>): string {
  const inbound = request.headers['x-request-id'];
  return isTraceId(inbound) ? inbound.toLowerCase() : randomUUID();
}

/** Reuse an initiating request's identifiers when a durable job runs later. */
export function withRequestTrace<T>(trace: Readonly<RequestTraceInput>, task: () => T): T {
  return storage.run(
    {
      traceId: trace.requestId,
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
        traceId: context.traceId,
        requestId: context.requestId,
        userId: context.userId,
        module: context.module,
        resource: context.resource,
      }
    : null;
}

/** Headers for an outbound call made on behalf of the current request or job. */
export function traceHeaders(): Record<string, string> {
  const context = storage.getStore();
  return context ? { 'X-Request-Id': context.traceId } : {};
}

/**
 * `fetch` that forwards the current trace as `X-Request-Id` (unless the caller set one). Used by
 * adapters for services that accept the header (API-v2 and internal services); headers that
 * already exist are never overwritten and nothing else about the request changes.
 */
export const tracedFetch: typeof fetch = (input, init) => {
  const trace = traceHeaders();
  if (!trace['X-Request-Id']) return fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', trace['X-Request-Id']);
  return fetch(input, { ...init, headers });
};

export function registerRequestTrace(app: FastifyInstance) {
  app.addHook('onRequest', (request, _reply, done) => {
    const trace = request.routeOptions.config.trace || {
      module: 'system',
      resource: 'http-request',
    };
    storage.run(
      {
        traceId: request.id,
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
