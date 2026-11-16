import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { walletAdjustmentSchema, walletCustomerLookupSchema } from './contracts.js';
import { walletAdjustmentRepository } from './repository.js';

const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'checkout', resource, action } },
});
export function registerWalletAdjustments(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  repository = walletAdjustmentRepository(db, config.BUSINESS_TIMEZONE),
) {
  app.get(
    '/api/v1/wallet-adjustment-capabilities',
    trace('wallet-adjustment-capability', 'read'),
    (request) => repository.capabilities(authenticated(request)),
  );
  app.post(
    '/api/v1/benefit-customer-lookups',
    trace('benefit-customer-lookup', 'create'),
    (request) =>
      repository.lookup(authenticated(request), walletCustomerLookupSchema.parse(request.body)),
  );
  app.post('/api/v1/wallet-adjustments', trace('wallet-adjustment', 'create'), (request) =>
    repository.adjust(authenticated(request), walletAdjustmentSchema.parse(request.body)),
  );
  app.get(
    '/api/v1/wallet-adjustments/:operationId',
    trace('wallet-adjustment', 'read'),
    (request) =>
      repository.get(
        authenticated(request),
        z.object({ operationId: z.uuid() }).parse(request.params).operationId,
      ),
  );
}
