import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { contactScope, type CustomerContactDelivery } from './contracts.js';
import { readCustomerContactOptions, type CustomerContactOptions } from './options.js';
import { createCustomerContactDelivery } from './delivery.js';
import { customerContactService } from './service.js';

export function registerCustomerContacts(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: CustomerContactOptions = readCustomerContactOptions(),
  delivery: CustomerContactDelivery | undefined = createCustomerContactDelivery(config, options),
) {
  const service = customerContactService(config, db, options, delivery);
  const base = '/api/v1/stores/:storeId/checkout-sessions/:checkoutId',
    challengePath = base + '/customer-contact-challenges/:challengeId';
  const empty = z.object({}).strict(),
    challengeParams = contactScope.extend({ challengeId: z.uuid() }).strict();
  const trace = (action: string, maximum = 30) => ({
    config: {
      trace: { module: 'customer-contacts', resource: 'customer-contact-challenge', action },
      rateLimit: { max: maximum, timeWindow: '1 minute' },
    },
    bodyLimit: 4096,
  });
  app.get(base + '/customer-contacts', trace('read-workspace', 60), async (request, reply) => {
    const user = authenticated(request);
    empty.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.read(user, contactScope.parse(request.params)));
  });
  app.post(base + '/customer-contact-challenges', trace('create', 10), async (request, reply) => {
    const user = authenticated(request);
    empty.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.request(user, contactScope.parse(request.params), request.body));
  });
  app.get(challengePath, trace('read', 60), async (request, reply) => {
    const user = authenticated(request);
    empty.parse(request.query);
    const { challengeId, ...scope } = challengeParams.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.challenge(user, scope, challengeId));
  });
  app.post(challengePath + '/verifications', trace('verify', 15), async (request, reply) => {
    const user = authenticated(request);
    empty.parse(request.query);
    const { challengeId, ...scope } = challengeParams.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.verify(user, scope, challengeId, request.body));
  });
  app.post(challengePath + '/resends', trace('resend', 10), async (request, reply) => {
    const user = authenticated(request);
    empty.parse(request.query);
    const { challengeId, ...scope } = challengeParams.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.resend(user, scope, challengeId, request.body));
  });
  app.post(challengePath + '/commits', trace('commit', 10), async (request, reply) => {
    const user = authenticated(request);
    empty.parse(request.query);
    const { challengeId, ...scope } = challengeParams.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.commit(user, scope, challengeId, request.body));
  });
  app.post(challengePath + '/cancellations', trace('cancel', 15), async (request, reply) => {
    const user = authenticated(request);
    empty.parse(request.query);
    const { challengeId, ...scope } = challengeParams.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.cancel(user, scope, challengeId, request.body));
  });
  app.get(
    challengePath + '/operations/:operationId',
    trace('read-operation', 60),
    async (request, reply) => {
      const user = authenticated(request);
      empty.parse(request.query);
      const { operationId, challengeId, ...scope } = challengeParams
        .extend({ operationId: z.uuid() })
        .strict()
        .parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.operation(user, scope, challengeId, operationId));
    },
  );
  return service;
}
export { readCustomerContactOptions } from './options.js';
export { createCustomerContactDelivery } from './delivery.js';
export { pruneCustomerContactProofs } from './prune.js';
