import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { shippingLabelService } from './service.js';
import { shippingLabelCsp, shippingLabelDocument } from './document.js';

export function registerShippingLabels(
  app: FastifyInstance,
  db: Databases,
  options: { read?: ReturnType<typeof shippingLabelService> } = {},
) {
  const read = options.read || shippingLabelService(db),
    path = '/api/v1/stores/:storeId/fulfillment/orders/:orderId/shipping-label';
  const params = z.object({ storeId: identifier, orderId: identifier }).strict();
  const scope = (request: Parameters<typeof authenticated>[0]) => {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign back in before continuing.',
      );
    z.object({}).strict().parse(request.query);
    return user;
  };
  app.get(
    path,
    { config: { trace: { module: 'fulfillment', resource: 'shipping-label', action: 'read' } } },
    async (request, reply) => {
      const user = scope(request),
        value = params.parse(request.params);
      reply
        .header('Cache-Control', 'private, no-store')
        .header('Pragma', 'no-cache')
        .header('Vary', 'Cookie, X-Operator-ID');
      return { data: await read(user, value.storeId, value.orderId) };
    },
  );
  app.get(
    path + '/preview',
    { config: { trace: { module: 'fulfillment', resource: 'shipping-label', action: 'preview' } } },
    async (request, reply) => {
      const user = scope(request),
        value = params.parse(request.params),
        document = shippingLabelDocument(await read(user, value.storeId, value.orderId));
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Pragma', 'no-cache')
        .header('Vary', 'Cookie, X-Operator-ID')
        .header('Content-Security-Policy', shippingLabelCsp)
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .type('text/html; charset=utf-8')
        .send(document.html);
    },
  );
}
