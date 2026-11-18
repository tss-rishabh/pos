import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { contactScope, updateEmailInput, updateTelephoneInput } from './contracts.js';
import { customerContactService } from './service.js';
export { customerContactService } from './service.js';

/** Legacy `ajax-m-user-mobile` / `ajax-m-user-email` (`order/urls.py:58-59`). */
export function registerCustomerContacts(app: FastifyInstance, config: Config, db: Databases) {
  const service = customerContactService(config, db),
    base = '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-contacts';
  const trace = (action: string) => ({
    config: { trace: { module: 'customer-contacts', resource: 'customer-contact', action } },
  });
  async function current(request: FastifyRequest) {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Refresh this sale.',
      );
    z.object({}).strict().parse(request.query);
    return { user, scope: contactScope.parse(request.params) };
  }
  app.get(base, trace('read'), async (request, reply) => {
    const { user, scope } = await current(request);
    return reply.header('Cache-Control', 'no-store').send(await service.workspace(user, scope));
  });
  app.post(base + '/telephone', trace('update-telephone'), async (request) => {
    const { user, scope } = await current(request),
      input = updateTelephoneInput.parse(request.body);
    return service.updateTelephone(user, scope, input.phoneNumber);
  });
  app.post(base + '/email', trace('update-email'), async (request) => {
    const { user, scope } = await current(request),
      input = updateEmailInput.parse(request.body);
    return service.updateEmail(user, scope, input.email);
  });
  return service;
}
