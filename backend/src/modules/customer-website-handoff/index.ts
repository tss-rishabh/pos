import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { sameToken } from '../application-links/domain.js';
import { customerWebsiteHandoffService } from './service.js';
import {
  configuredWebsiteHandoff,
  readCustomerWebsiteHandoffOptions,
  type CustomerWebsiteHandoffOptions,
} from './options.js';
import {
  websiteHandoffIssue,
  websiteHandoffRedemption,
  websiteHandoffScope,
  websiteHandoffSession,
} from './contracts.js';
import type { WebsiteSessionProbe, WebsiteVerification } from './authority.js';
export { readCustomerWebsiteHandoffOptions } from './options.js';
export { customerWebsiteHandoffService } from './service.js';
export function registerCustomerWebsiteHandoff(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  verification: WebsiteVerification | undefined,
  options: CustomerWebsiteHandoffOptions = readCustomerWebsiteHandoffOptions(),
  sessionAlive?: WebsiteSessionProbe,
) {
  const service = customerWebsiteHandoffService(
      config,
      db,
      options,
      verification,
      Date.now,
      sessionAlive,
    ),
    base = '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-website-handoffs',
    empty = (value: unknown) =>
      z
        .object({})
        .strict()
        .parse(value ?? {});
  const trace = (resource: string, action: string) => ({
    config: {
      trace: { module: 'customer-website-handoff', resource, action },
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  });
  function session(request: FastifyRequest) {
    const parsed = websiteHandoffSession.safeParse({
      id: request.authSessionId,
      expiresAt: request.sessionExpiresAt,
    });
    if (!parsed.success)
      throw new AppError(
        401,
        'SESSION_EXPIRED',
        'Sign in again before opening the customer website.',
      );
    return parsed.data;
  }
  async function current(request: FastifyRequest) {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Refresh this sale.',
      );
    return user;
  }
  async function stillCurrent(request: FastifyRequest) {
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(
        401,
        'SESSION_EXPIRED',
        'Sign in again before opening the customer website.',
      );
  }
  app.get(base + '/capabilities', trace('website-handoff', 'read'), async (request, reply) => {
    empty(request.query);
    const user = await current(request),
      result = await service.capabilities(
        user,
        websiteHandoffScope.parse(request.params),
        session(request),
      );
    await stillCurrent(request);
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post(base, trace('website-handoff', 'create'), async (request, reply) => {
    empty(request.query);
    const user = await current(request),
      result = await service.issue(
        user,
        websiteHandoffScope.parse(request.params),
        websiteHandoffIssue.parse(request.body),
        session(request),
      );
    await stillCurrent(request);
    return reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(result);
  });
  app.delete(base + '/:grantId', trace('website-handoff', 'revoke'), async (request, reply) => {
    empty(request.query);
    empty(request.body);
    const params = websiteHandoffScope.extend({ grantId: z.uuid() }).parse(request.params),
      user = await current(request),
      result = await service.revoke(
        user,
        { storeId: params.storeId, checkoutId: params.checkoutId },
        params.grantId,
      );
    await stillCurrent(request);
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post(
    '/api/v1/auth/customer-website-handoffs/redemptions',
    {
      config: {
        authentication: 'service',
        trace: {
          module: 'customer-website-handoff',
          resource: 'website-handoff-redemption',
          action: 'consume',
        },
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      preValidation: async (request) => {
        const setup = configuredWebsiteHandoff(config, options),
          supplied = request.headers['x-customer-website-handoff-key'];
        if (typeof supplied !== 'string' || !sameToken(supplied, setup.key))
          throw new AppError(
            401,
            'WEBSITE_RECEIVER_AUTH_REQUIRED',
            'The authenticated website receiver is required.',
          );
        if (request.headers.origin !== setup.url.origin)
          throw new AppError(403, 'ORIGIN_DENIED', 'Request origin is not allowed.');
      },
    },
    async (request, reply) => {
      empty(request.query);
      const result = await service.redeem(websiteHandoffRedemption.parse(request.body));
      request.auditUserId = result.operatorId;
      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(result);
    },
  );
  return service;
}
