import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import {
  storeImageAttachInput,
  storeImageUploadInput,
  type storeImageService,
} from './store-images.js';

const scope = z.object({ storeId: identifier }).strict(),
  uploadScope = scope.extend({ uploadId: z.uuid() });
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
  app.get('/api/v1/admin/stores/:storeId/image', trace('read'), async (request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send(await media.get(authenticated(request), scope.parse(request.params).storeId)),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/image-uploads',
    trace('reserve'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await media.reserve(
            authenticated(request),
            scope.parse(request.params).storeId,
            storeImageUploadInput.parse(request.body),
          ),
        ),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/image-uploads/:uploadId/attachment',
    trace('attach'),
    async (request, reply) => {
      const { storeId, uploadId } = uploadScope.parse(request.params),
        user = authenticated(request);
      await media.attach(
        user,
        storeId,
        uploadId,
        storeImageAttachInput.parse(request.body).revision,
      );
      return reply
        .header('Cache-Control', 'no-store')
        .send({ status: 'success', image: await media.get(user, storeId) });
    },
  );
  app.get('/api/v1/admin/stores/:storeId/image/content', trace('read'), async (request, reply) => {
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
  });
}
