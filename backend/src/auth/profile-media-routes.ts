import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from './routes.js';
import type { ProfileService } from './profile.js';
import {
  profileAttachInput,
  profileImageKind,
  profileUploadInput,
  type profileMediaService,
} from './profile-media.js';

export function registerProfileMedia(
  app: FastifyInstance,
  media: ReturnType<typeof profileMediaService>,
  profile: ProfileService,
) {
  const trace = (action: string) => ({
    config: {
      trace: { module: 'identity', resource: 'operator-profile-image', action },
      rateLimit: { max: action === 'read' ? 60 : 10, timeWindow: '1 minute' },
    },
  });
  app.post(
    '/api/v1/operators/current/profile/image-uploads',
    trace('reserve'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(await media.reserve(authenticated(request), profileUploadInput.parse(request.body))),
  );
  app.post(
    '/api/v1/operators/current/profile/image-uploads/:uploadId/attachment',
    trace('attach'),
    async (request, reply) => {
      const user = authenticated(request),
        { uploadId } = z.object({ uploadId: z.uuid() }).strict().parse(request.params);
      await media.attach(user, uploadId, profileAttachInput.parse(request.body).revision);
      return reply
        .header('Cache-Control', 'no-store')
        .send({ profile: await profile.get(user), sessionExpiresAt: request.sessionExpiresAt });
    },
  );
  app.get(
    '/api/v1/operators/current/profile/images/:kind',
    trace('read'),
    async (request, reply) => {
      const { kind } = z.object({ kind: profileImageKind }).strict().parse(request.params);
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const image = await media.stream(authenticated(request), kind, controller.signal);
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Type', image.contentType)
        .header('Content-Length', image.size!)
        .header('Content-Disposition', 'inline; filename="account-image"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(image.body);
    },
  );
}
