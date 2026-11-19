import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import { identifier } from '../../domain/validation.js';
import { storeImageReservationInput, type storeImageService } from './store-images.js';

const scope = z.object({ storeId: identifier }).strict();
/** The admin client appends the image revision as a cache key (`?v=<revision>`). */
const contentQuery = z.strictObject({
  v: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export function registerStoreImages(
  app: FastifyInstance,
  media: ReturnType<typeof storeImageService>,
) {
  const trace = (action: string) => ({
    config: {
      trace: { module: 'administration', resource: 'store-image', action },
      rateLimit: { max: action === 'read' ? 60 : 10, timeWindow: '1 minute' },
    },
  });
  const read = {
    ...trace('read'),
    ...routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
  };
  app.get('/api/v1/admin/stores/:storeId/image', read, async (request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send(await media.get(authenticated(request), scope.parse(request.params).storeId)),
  );
  app.post(
    '/api/v1/admin/store-image-uploads',
    {
      ...trace('reserve'),
      ...routeSchema({
        querystring: noQuery,
        body: storeImageReservationInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) =>
      reply
        .code(201)
        .header('Cache-Control', 'no-store')
        .send(
          await media.reserve(
            authenticated(request),
            storeImageReservationInput.parse(request.body),
          ),
        ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/image/content',
    {
      ...trace('read'),
      ...routeSchema({ params: scope, querystring: contentQuery, headers: transportHeaders }),
    },
    async (request, reply) => {
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const image = await media.stream(
        authenticated(request),
        scope.parse(request.params).storeId,
        controller.signal,
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Type', image.contentType)
        .header('Content-Length', image.size!)
        .header('Content-Disposition', 'inline; filename="store-image"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(image.body);
    },
  );
}
