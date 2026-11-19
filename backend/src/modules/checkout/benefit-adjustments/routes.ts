import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../../domain/route-validation.js';
import { walletAdjustmentSchema, walletCustomerLookupSchema } from './contracts.js';
import type { JobProducer } from '../../../jobs/contract.js';
import type { CheckoutSessionStore } from '../session-store.js';
import type { PosStateStore } from '../state-store.js';
import { walletAdjustmentRepository } from './repository.js';

const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'checkout', resource, action } },
});
const adjustmentParams = z.object({ operationId: z.uuid() }).strict();
export interface WalletAdjustmentRegistrationOptions {
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  jobs?: JobProducer;
  repository?: ReturnType<typeof walletAdjustmentRepository>;
}
export function registerWalletAdjustments(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: WalletAdjustmentRegistrationOptions = {},
) {
  const repository =
    options.repository ||
    walletAdjustmentRepository(db, config, {
      stateStore: options.stateStore || options.sessions?.store,
    });
  app.get(
    '/api/v1/wallet-adjustment-capabilities',
    {
      ...trace('wallet-adjustment-capability', 'read'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    (request) => repository.capabilities(authenticated(request)),
  );
  app.post(
    '/api/v1/benefit-customer-lookups',
    {
      ...trace('benefit-customer-lookup', 'create'),
      ...routeSchema({
        querystring: noQuery,
        body: walletCustomerLookupSchema,
        headers: transportHeaders,
      }),
    },
    (request) =>
      repository.lookup(authenticated(request), walletCustomerLookupSchema.parse(request.body)),
  );
  app.post(
    '/api/v1/wallet-adjustments',
    {
      ...trace('wallet-adjustment', 'create'),
      ...routeSchema({
        querystring: noQuery,
        body: walletAdjustmentSchema,
        headers: transportHeaders,
      }),
    },
    (request) =>
      repository.adjust(authenticated(request), walletAdjustmentSchema.parse(request.body)),
  );
  app.get(
    '/api/v1/wallet-adjustments/:operationId',
    {
      ...trace('wallet-adjustment', 'read'),
      ...routeSchema({
        params: adjustmentParams,
        querystring: noQuery,
        headers: transportHeaders,
      }),
    },
    (request) =>
      repository.get(authenticated(request), adjustmentParams.parse(request.params).operationId),
  );
}
