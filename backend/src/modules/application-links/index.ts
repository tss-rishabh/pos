import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import {
  operation,
  staffActivation,
  staffContent,
  customerScan,
  readApplicationLinkOptions,
  type ApplicationLinkOptions,
} from './contracts.js';
import { createApplicationPackage } from './artifact.js';
import { createCustomerApplicationProvider } from './provider.js';
import { applicationLinkService, type ApplicationLinkDependencies } from './service.js';

export { readApplicationLinkOptions } from './contracts.js';
export { createApplicationPackage } from './artifact.js';
export { createCustomerApplicationProvider } from './provider.js';
export { applicationLinkService, pruneApplicationLinks } from './service.js';
export function registerApplicationLinks(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: ApplicationLinkOptions = readApplicationLinkOptions(),
  dependencies: ApplicationLinkDependencies = {},
) {
  const artifact = dependencies.artifact ?? createApplicationPackage(config, options),
    customerLink = dependencies.customerLink ?? createCustomerApplicationProvider(config, options),
    service = applicationLinkService(config, db, options, { artifact, customerLink });
  app.addHook('onClose', async () => {
    await artifact?.close();
  });
  const trace = (resource: string, action: string, max = 30, publicProof = false) => ({
      config: {
        ...(publicProof ? { authentication: 'service' as const } : {}),
        trace: { module: 'application-links', resource, action },
        rateLimit: { max, timeWindow: '1 minute' },
      },
      onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
        if (publicProof && request.headers.origin !== new URL(config.WEB_ORIGIN).origin)
          throw new AppError(403, 'ORIGIN_DENIED', 'Request origin is not allowed.');
      },
    }),
    empty = (value: unknown) =>
      z
        .object({})
        .strict()
        .parse(value ?? {});
  app.get(
    '/api/v1/operators/current/application-links/capabilities',
    trace('application-link', 'read'),
    async (request) => {
      empty(request.query);
      return service.capabilities(authenticated(request));
    },
  );
  app.post(
    '/api/v1/operators/current/application-links/staff-qr',
    trace('staff-download', 'create'),
    async (request) => {
      empty(request.query);
      return service.issueStaff(authenticated(request), operation.parse(request.body));
    },
  );
  app.delete(
    '/api/v1/operators/current/application-links/staff-qr/:grantId',
    trace('staff-download', 'revoke'),
    async (request) => {
      empty(request.query);
      empty(request.body);
      const params = z.object({ grantId: z.uuid() }).strict().parse(request.params);
      return service.revokeStaff(authenticated(request), params.grantId);
    },
  );
  app.post(
    '/api/v1/operators/current/application-links/customer-qr',
    trace('customer-application-link', 'create'),
    async (request) => {
      empty(request.query);
      empty(request.body);
      return service.issueCustomer(authenticated(request));
    },
  );
  app.post(
    '/api/v1/auth/application-links/staff-download-activations',
    trace('staff-download-activation', 'create', 12, true),
    async (request, reply) => {
      empty(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(await service.activateStaff(staffActivation.parse(request.body)));
    },
  );
  app.post(
    '/api/v1/auth/application-links/staff-download-content',
    trace('staff-download-content', 'download', 12, true),
    async (request, reply) => {
      empty(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      const opened = await service.downloadStaff(
        staffContent.parse(request.body),
        controller.signal,
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('Content-Type', 'application/vnd.android.package-archive')
        .header('Content-Length', opened.metadata.bytes)
        .header('Content-Disposition', 'attachment; filename="mpos.apk"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(opened.stream);
    },
  );
  app.post(
    '/api/v1/auth/application-links/customer-scans',
    trace('customer-application-scan', 'create', 30, true),
    async (request, reply) => {
      empty(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(await service.scanCustomer(customerScan.parse(request.body)));
    },
  );
  return service;
}
