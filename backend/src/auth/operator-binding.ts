import type { FastifyInstance } from 'fastify';
import { AppError } from '../domain/errors.js';

/** A shared cookie can change in another tab while the old editor is still open. */
export function registerOperatorBinding(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    const route = request.routeOptions.url || '';
    if (
      !request.principal ||
      request.routeOptions.config.authentication === 'service' ||
      route.startsWith('/api/v1/auth/')
    )
      return;
    const expected = request.headers['x-operator-id'],
      mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (
      (expected !== undefined && expected !== request.principal.id) ||
      (mutation && expected === undefined)
    )
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Refresh the workspace before continuing.',
      );
  });
}
