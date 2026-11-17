import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../../auth/routes.js';
import type { PublicScreeningCoordinator } from './coordinator.js';
import { publicScreeningRequest } from './request-scope.js';
import { publicScreeningRecovery } from './recovery.js';
import { publicScreeningScopeSchema, publicScreeningAbandonInputSchema } from './api-contracts.js';
export function registerPublicScreening(
  app: FastifyInstance,
  coordinator: PublicScreeningCoordinator,
) {
  const service = publicScreeningRecovery(coordinator),
    base =
      '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/screening-admissions/:operationId',
    trace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'screening-admission', action } },
    });
  app.get(base, trace('read'), async (request) => {
    const user = authenticated(request),
      p = publicScreeningScopeSchema.parse(request.params);
    return publicScreeningRequest(request, user, () => service.read(user, p));
  });
  app.post(base + '/reconciliations', trace('reconcile'), async (request) => {
    const user = authenticated(request),
      p = publicScreeningScopeSchema.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return publicScreeningRequest(request, user, () => service.reconcile(user, p));
  });
  app.post(base + '/closures', trace('close-unsent'), async (request) => {
    const user = authenticated(request),
      p = publicScreeningScopeSchema.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return publicScreeningRequest(request, user, () => service.closeUnsent(user, p));
  });
  app.post(base + '/abandonments', trace('abandon'), async (request) => {
    const user = authenticated(request),
      p = publicScreeningScopeSchema.parse(request.params),
      body = publicScreeningAbandonInputSchema.parse(request.body);
    return publicScreeningRequest(request, user, () => service.abandon(user, p, body));
  });
  return service;
}
