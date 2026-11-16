import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { customerProfileScope } from './contracts.js';
import { customerProfileService } from './profile.js';
import { customerProfileAdjustmentService } from './adjustments.js';
import { checkoutEnvironment } from '../checkout/gateway.js';
import { customerBriefingService } from './briefing.js';
import { customerBriefingGateway } from './briefing-gateway.js';
import { readCustomerBriefingOptions } from './briefing-options.js';
import { appCashbackCampaign } from './benefits-gateway.js';
import { customerBenefitsService } from './benefits.js';

export function registerCustomerWorkspace(app: FastifyInstance, config: Config, db: Databases) {
  const environment = checkoutEnvironment();
  const service = customerProfileService(config, db, environment);
  const adjustments = customerProfileAdjustmentService(config, db, environment);
  const benefits = customerBenefitsService(config, db, appCashbackCampaign(config));
  const insights = customerBriefingService(
    config,
    db,
    customerBriefingGateway(config, readCustomerBriefingOptions()),
  );
  app.get(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-profile',
    {
      config: {
        trace: { module: 'customer-workspace', resource: 'customer-profile', action: 'read' },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const result = await service.read(
        authenticated(request),
        customerProfileScope.parse(request.params),
      );
      return reply.header('Cache-Control', 'private, no-store').send(result);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-benefits',
    {
      config: {
        trace: { module: 'customer-workspace', resource: 'customer-benefit', action: 'read' },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await benefits.read(authenticated(request), customerProfileScope.parse(request.params)),
        );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-insights',
    {
      config: {
        trace: { module: 'customer-workspace', resource: 'customer-insight', action: 'read' },
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await insights.read(authenticated(request), customerProfileScope.parse(request.params)),
        );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-profile-adjustments',
    {
      config: {
        trace: {
          module: 'customer-workspace',
          resource: 'customer-profile-adjustment',
          action: 'create',
        },
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await adjustments.apply(
            authenticated(request),
            customerProfileScope.parse(request.params),
            request.body,
          ),
        );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-profile-adjustments/:operationId',
    {
      config: {
        trace: {
          module: 'customer-workspace',
          resource: 'customer-profile-adjustment',
          action: 'read',
        },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const { operationId, ...scope } = customerProfileScope
        .extend({ operationId: z.uuid() })
        .strict()
        .parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await adjustments.read(authenticated(request), scope, operationId));
    },
  );
}
