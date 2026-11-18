import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Writable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readConfig, type Config } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { registerEventCatalog, requestEvent } from '../../observability/events.js';
import { registerRequestTrace } from '../../observability/context.js';
import { orderMutationGuards } from '../checkout/order-mutation-guards.js';
import { qualifiedStatusEndpoint, readWholeOrderStatusOptions } from './options.js';
import { readStatusReceiverOptions, receiverEndpoints } from './receiver-options.js';
import { authenticateStatusReceiver, type WholeOrderStatusReceiver } from './receiver.js';
import { registerQualifiedWholeOrderStatusReceiver } from './receiver-plugin.js';

const configurationRequired = () =>
  new AppError(
    503,
    'WHOLE_ORDER_STATUS_PRIVATE_CONFIGURATION_REQUIRED',
    'The private STORE receiver configuration needs review.',
  );
const flag = z.preprocess(
  (value) =>
    value === undefined || value === ''
      ? false
      : value === 'true'
        ? true
        : value === 'false'
          ? false
          : value,
  z.boolean(),
);

/** All validation happens before constructing pools or registering a background loop. */
function privateConfiguration(env: NodeJS.ProcessEnv) {
  try {
    if (flag.parse(env.DEMO_MODE)) return { enabled: false, reason: 'demo' } as const;
    if (!flag.parse(env.WHOLE_ORDER_STATUS_RECEIVER_ENABLED))
      return { enabled: false, reason: 'not-selected' } as const;
    const config = readConfig(env),
      options = readWholeOrderStatusOptions(env),
      receiverOptions = readStatusReceiverOptions(env),
      bind = z
        .object({
          WHOLE_ORDER_STATUS_RECEIVER_HOST: z
            .string()
            .refine((value) => value === 'localhost' || isIP(value) !== 0)
            .default('127.0.0.1'),
          WHOLE_ORDER_STATUS_RECEIVER_PORT: z.coerce
            .number()
            .int()
            .min(config.NODE_ENV === 'test' ? 0 : 1)
            .max(65535)
            .default(4422),
          POS_PAYMENT_CORRECTION_PROOF_KEY_V1: z.string().min(32).max(4096),
        })
        .parse(env);
    receiverEndpoints(config, options, receiverOptions);
    const base = qualifiedStatusEndpoint(config, options),
      rawPath =
        /^https?:\/\/[^/?#]+(\/[^?#]*)?$/.exec(options.BACKEND_SYNC_API_BASE_URL!)?.[1] || '/';
    // Router syntax, encoded separators, dot normalization and duplicate separators
    // cannot turn a configured prefix into a second route surface.
    if (
      rawPath.length > 256 ||
      !/^\/(?:[A-Za-z0-9_-]{1,64}\/)*[A-Za-z0-9_-]{0,64}$/.test(rawPath) ||
      base.pathname.replace(/\/$/, '') !== rawPath.replace(/\/$/, '')
    )
      throw configurationRequired();
    if (!config.MYSQL_WRITER_URL) throw configurationRequired();
    for (const raw of [
      config.MYSQL_WRITER_URL,
      config.MYSQL_PRIMARY_READER_URL,
      config.MYSQL_DATA_READER_URL,
    ]) {
      if (!raw) continue;
      const url = new URL(raw);
      if (
        url.protocol !== 'mysql:' ||
        !/^\/[A-Za-z0-9_$-]+$/.test(url.pathname) ||
        url.search ||
        url.hash
      )
        throw configurationRequired();
      // The pool decodes credentials. Reject malformed escapes before any pool
      // can be constructed, including pools for earlier valid URLs.
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
    }
    return {
      enabled: true,
      config,
      options,
      receiverOptions,
      host: bind.WHOLE_ORDER_STATUS_RECEIVER_HOST,
      port: bind.WHOLE_ORDER_STATUS_RECEIVER_PORT,
      prefix: base.pathname.replace(/\/$/, ''),
      keys: {
        cashReturnProofKey: bind.POS_PAYMENT_CORRECTION_PROOF_KEY_V1,
      },
    } as const;
  } catch {
    // Zod issues and URL/driver errors can contain raw environment values.
    throw configurationRequired();
  }
}

class PrivateReceiverLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
export function privateReceiverLifecycle(
  action: 'disabled' | 'started' | 'stopped' | 'startup-failed' | 'shutdown-failed',
  requestId: string,
) {
  return {
    module: 'whole-order-status',
    resource: 'private-receiver-runtime',
    eventId: `whole-order-status.private-receiver-runtime.${action}`,
    eventInstanceId: randomUUID(),
    requestId,
    userId: null,
  };
}

function privateHttp(
  app: FastifyInstance,
  options: ReturnType<typeof readWholeOrderStatusOptions>,
) {
  app.decorateRequest('principal', null);
  app.decorateRequest('auditUserId', null);
  registerEventCatalog(app);
  registerRequestTrace(app);
  const failures = new WeakMap<object, string>();
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Request-ID', request.id);
    if (request.routeOptions.config.trace?.resource === 'whole-order-status-receiver')
      request.auditUserId = authenticateStatusReceiver(request.headers, options).operatorId;
  });
  app.setErrorHandler((error, request, reply) => {
    const application = error instanceof AppError,
      invalid = error instanceof z.ZodError,
      frameworkCode =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : null,
      code =
        application && /^[A-Z][A-Z0-9_]{2,79}$/.test(error.code)
          ? error.code
          : invalid
            ? 'VALIDATION_ERROR'
            : frameworkCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
                frameworkCode === 'FST_ERR_CTP_EMPTY_JSON_BODY'
              ? 'VALIDATION_ERROR'
              : frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE'
                ? 'PAYLOAD_TOO_LARGE'
                : 'WHOLE_ORDER_STATUS_RECEIVER_UNAVAILABLE',
      status =
        application &&
        Number.isSafeInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : code === 'VALIDATION_ERROR'
            ? 400
            : code === 'PAYLOAD_TOO_LARGE'
              ? 413
              : 503;
    // Only a static error classification is logged; no error/SQL/validation object.
    failures.set(
      request,
      status < 500 ? 'PRIVATE_RECEIVER_REJECTED' : 'PRIVATE_RECEIVER_UNAVAILABLE',
    );
    void reply
      .code(status)
      .send({ code, message: 'The private status request could not be completed.' });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: 'NOT_FOUND', message: 'Private receiver route not found.' }),
  );
  app.addHook('onResponse', async (request, reply) => {
    app.log.info(
      requestEvent(request, reply, failures.get(request)),
      'Private status request completed.',
    );
  });
}

export interface PrivateWholeOrderRuntimeDependencies {
  createDatabases?: (config: Config) => Databases;
  /** Test/sandbox ports only; the financial barrier is always the real shared composition. */
  fetcher?: typeof fetch;
  clock?: () => number;
  logger?: false;
  logStream?: Writable;
}

/** Private HMAC routes only. Browser cookies, public POS routes and the public sender
 * worker are deliberately never registered in this process. */
export async function buildPrivateWholeOrderStatusRuntime(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PrivateWholeOrderRuntimeDependencies = {},
) {
  const settings = privateConfiguration(env);
  if (!settings.enabled) return { ...settings, stop: async () => {} } as const;
  const lifecycleRequestId = randomUUID(),
    app = Fastify({
      logController: new PrivateReceiverLogController(),
      logger:
        dependencies.logger === false
          ? false
          : {
              base: null,
              ...(dependencies.logStream ? { stream: dependencies.logStream } : {}),
              serializers: {
                req: () => ({}),
                res: (reply) => ({ statusCode: reply.statusCode }),
                err: () => ({
                  type: 'InternalError',
                  message: 'Private receiver unavailable.',
                  stack: '',
                }),
              },
              mixin: () => privateReceiverLifecycle('started', lifecycleRequestId),
            },
      genReqId: () => randomUUID(),
      bodyLimit: 256000,
      requestTimeout: 15000,
      connectionTimeout: 10000,
      trustProxy: false,
    });
  let db: Databases | undefined, stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= app.close());
  try {
    privateHttp(app, settings.options);
    db = (dependencies.createDatabases ?? createDatabases)(settings.config);
    const databases = db;
    // Parent close runs after the child worker has stopped and joined its current tick.
    app.addHook('onClose', async () => databases.close());
    app.get(
      '/health/live',
      {
        config: {
          authentication: 'service',
          trace: {
            module: 'whole-order-status',
            resource: 'private-receiver-liveness',
            action: 'read',
          },
        },
      },
      async () => ({ status: 'ok' }),
    );
    let receiver: WholeOrderStatusReceiver | undefined;
    await app.register(
      async (scope) => {
        receiver = await registerQualifiedWholeOrderStatusReceiver(
          scope,
          settings.config,
          databases,
          settings.options,
          settings.receiverOptions,
          {
            assertHandoverAvailable: orderMutationGuards(settings.keys).assertHandoverAvailable,
            ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
            ...(dependencies.clock ? { clock: dependencies.clock } : {}),
          },
        );
        receiver.ready();
      },
      { prefix: settings.prefix },
    );
    if (!receiver) throw configurationRequired();
    return {
      enabled: true,
      app,
      receiver,
      host: settings.host,
      port: settings.port,
      listen: () => app.listen({ host: settings.host, port: settings.port }),
      stop,
    } as const;
  } catch {
    await stop().catch(() => undefined);
    throw configurationRequired();
  }
}
