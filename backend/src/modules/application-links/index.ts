import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import {
  operation,
  staffActivation,
  staffContent,
  customerScan,
  legacyCustomerScan,
  readApplicationLinkOptions,
  type ApplicationLinkOptions,
} from './contracts.js';
import {
  createCustomerApplicationProvider,
  createStaffApplicationPackage,
  type CustomerApplicationProvider,
  type StaffApplicationPackage,
} from './provider.js';
import { applicationLinkService } from './service.js';

export { readApplicationLinkOptions } from './contracts.js';
export { createCustomerApplicationProvider, createStaffApplicationPackage } from './provider.js';
export { applicationLinkService, pruneApplicationLinks } from './service.js';
export function registerApplicationLinks(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  runtime: { ephemeral: EphemeralStore },
  options: ApplicationLinkOptions = readApplicationLinkOptions(),
  dependencies: {
    staffPackage?: StaffApplicationPackage;
    customerLink?: CustomerApplicationProvider;
  } = {},
) {
  const service = applicationLinkService(config, db, options, {
    ephemeral: runtime.ephemeral,
    staffPackage: dependencies.staffPackage ?? createStaffApplicationPackage(config, options),
    customerLink: dependencies.customerLink ?? createCustomerApplicationProvider(config, options),
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
    async (request) => {
      empty(request.query);
      return service.activateStaff(staffActivation.parse(request.body));
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
      if (opened.contentLength && /^\d+$/.test(opened.contentLength))
        reply.header('Content-Length', opened.contentLength);
      return reply
        .header('Content-Type', opened.contentType)
        .header('Content-Disposition', 'attachment; filename="mpos.apk"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(opened.stream);
    },
  );
  app.post(
    '/api/v1/auth/application-links/customer-scans',
    trace('customer-application-scan', 'create', 30, true),
    async (request) => {
      empty(request.query);
      return service.scanCustomer(customerScan.parse(request.body));
    },
  );
  /**
   * Legacy public path for QR codes printed by the legacy app (core/urls.py:164). The reverse
   * proxy must route `/user_to_app` to this backend on the legacy POS host.
   */
  app.get(
    '/user_to_app',
    {
      config: {
        authentication: 'service' as const,
        trace: {
          module: 'application-links',
          resource: 'legacy-customer-scan',
          action: 'redirect',
        },
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const input = legacyCustomerScan.parse(request.query);
      const target = await service.scanLegacy(input.store_id);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .redirect(target, 302);
    },
  );
  return service;
}
