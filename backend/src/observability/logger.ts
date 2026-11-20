import { randomUUID } from 'node:crypto';
import type { FastifyServerOptions } from 'fastify';
import { currentRequestTrace } from './context.js';
import type { LogProcess } from './event-registry.js';

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

/** Keys whose values are personal data, credentials or raw inputs; removed at any of 3 levels. */
export const sensitiveLogKeys = [
  // credentials and secrets
  'password',
  'newPassword',
  'oldPassword',
  'currentPassword',
  'confirmPassword',
  'otp',
  'totp',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'apikey',
  'appkey',
  'serviceKey',
  'authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'x-api-key',
  'jwt',
  'signature',
  'credentials',
  // personal data
  'phone',
  'telephone',
  'mobile',
  'contact',
  'email',
  'firstName',
  'lastName',
  'first_name',
  'last_name',
  'customerName',
  'address',
  'pincode',
  'gstin',
  // raw request/response material and SQL
  'body',
  'payload',
  'query',
  'querystring',
  'params',
  'headers',
  'url',
  'sql',
  'sqlMessage',
  'parameters',
  'values',
  'response',
  'request',
  'req.headers',
  'cause',
  'stack',
  'config',
] as const;
const segment = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`);
const join = (prefix: string, key: string) =>
  segment(key).startsWith('[') ? `${prefix}${segment(key)}` : `${prefix}.${key}`;
/** pino `redact` paths: top level, one and two levels deep. */
export const redactPaths = sensitiveLogKeys.flatMap((key) =>
  key.includes('.')
    ? [key]
    : [segment(key), join('*', key), join('*.*', key)].map((path) =>
        path.startsWith('.') ? path.slice(1) : path,
      ),
);

/** Trace defaults for lines logged outside a request or job context. */
export interface LogFallback {
  requestId: string | null;
  module: string;
  resource: string;
  /** The writing process: `server` (HTTP API) or `worker` (job worker). */
  process?: LogProcess;
}

/**
 * Every log line carries the writing `process`, the trace of the request or job it belongs to
 * (`traceId`, `requestId`, `module`, `resource`, `userId`) and a unique `eventInstanceId`.
 * Registered resource events (observability/event-registry.ts, typed loggers) pass their own
 * `eventId`, which wins over the default; lines without one get `<module>.<resource>.log`. pino
 * adds `level`, epoch-ms `time` and `msg`, a fixed sentence per call site that carries no values.
 */
export function traceMixin(fallback: LogFallback) {
  return (event: object) => {
    const trace = currentRequestTrace(),
      module = trace?.module ?? fallback.module,
      resource = trace?.resource ?? fallback.resource,
      requestId = trace?.requestId ?? fallback.requestId,
      // An event that names its request (job records, request events) keeps traceId equal to it.
      explicit =
        'requestId' in event && typeof event.requestId === 'string' ? event.requestId : null;
    return {
      process: fallback.process ?? 'server',
      traceId: explicit ?? requestId,
      requestId,
      module,
      resource,
      userId: trace?.userId ?? null,
      eventId: `${module}.${resource}.log`,
      eventInstanceId: randomUUID(),
    };
  };
}

/** Shared pino options: trace mixin, redaction, and serializers that drop request/error detail. */
export function applicationLogger(
  options: LoggerOptions,
  fallback: LogFallback = {
    requestId: null,
    module: 'runtime',
    resource: 'server',
    process: 'server',
  },
): LoggerOptions {
  return {
    ...options,
    base: null,
    mixin: traceMixin(fallback),
    redact: { paths: redactPaths, remove: true },
    serializers: {
      req: () => ({}),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      err: () => ({ type: 'InternalError', message: 'Request failed', stack: '' }),
    },
  };
}
