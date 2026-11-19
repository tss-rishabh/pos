import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { customerWebsiteHandoffService } from './service.js';
import {
  readCustomerWebsiteHandoffOptions,
  type CustomerWebsiteHandoffOptions,
} from './options.js';
import { websiteHandoffIssue, websiteHandoffScope } from './contracts.js';
export { readCustomerWebsiteHandoffOptions } from './options.js';
export { customerWebsiteHandoffService } from './service.js';
/** Legacy `ajax-online-order/` (`order/urls.py:82`). */
export function registerCustomerWebsiteHandoff(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: CustomerWebsiteHandoffOptions = readCustomerWebsiteHandoffOptions(),
) {
  const service = customerWebsiteHandoffService(config, db, options);
  app.post(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-website-handoffs',
    {
      config: {
        trace: {
          module: 'customer-website-handoff',
          resource: 'website-handoff',
          action: 'create',
        },
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const user = authenticated(request);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The signed-in operator changed. Refresh this sale.',
        );
      if (!request.authSessionValid || !(await request.authSessionValid()))
        throw new AppError(
          401,
          'SESSION_EXPIRED',
          'Sign in again before opening the customer website.',
        );
      websiteHandoffIssue.parse(request.body ?? {});
      const result = await service.issue(user, websiteHandoffScope.parse(request.params));
      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(result);
    },
  );
  return service;
}
