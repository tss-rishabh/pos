import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticated } from './routes.js';
import type { ProfileService } from './profile.js';
import {
  profileAttachInput,
  profileImageKind,
  profileUploadInput,
  type profileMediaService,
} from './profile-media.js';
import { requestHeaders, routeSchema, type RouteSchema } from '../domain/route-validation.js';

const none = z.object({}).strict();
const headers = requestHeaders({ cookie: z.string().max(16384).optional() });
/** The profile page appends the image revision as a cache key (`?v=<revision>`). */
const imageQuery = z.strictObject({
  v: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const attachParams = z.object({ uploadId: z.uuid() }).strict();
const imageParams = z.object({ kind: profileImageKind }).strict();
function validate(request: FastifyRequest, query: z.ZodType = none) {
  query.parse(request.query ?? {});
  headers.parse(request.headers);
}
export function registerProfileMedia(
  app: FastifyInstance,
  media: ReturnType<typeof profileMediaService>,
  profile: ProfileService,
) {
  const trace = (action: string, schema: Omit<RouteSchema, 'headers'> = {}) => ({
    config: {
      trace: { module: 'identity', resource: 'operator-profile-image', action },
    },
    ...routeSchema({ querystring: none, ...schema, headers }),
  });
  app.post(
    '/api/v1/operators/current/profile/image-uploads',
    trace('reserve', { body: profileUploadInput }),
    async (request, reply) => {
      validate(request);
      none.parse(request.params ?? {});
      return reply
        .header('Cache-Control', 'no-store')
        .send(await media.reserve(authenticated(request), profileUploadInput.parse(request.body)));
    },
  );
  app.post(
    '/api/v1/operators/current/profile/image-uploads/:uploadId/attachment',
    trace('attach', { params: attachParams, body: profileAttachInput }),
    async (request, reply) => {
      validate(request);
      const user = authenticated(request),
        { uploadId } = attachParams.parse(request.params);
      await media.attach(user, uploadId, profileAttachInput.parse(request.body).revision);
      return reply
        .header('Cache-Control', 'no-store')
        .send({ profile: await profile.get(user), sessionExpiresAt: request.sessionExpiresAt });
    },
  );
  app.get(
    '/api/v1/operators/current/profile/images/:kind',
    trace('read', { params: imageParams, querystring: imageQuery }),
    async (request, reply) => {
      validate(request, imageQuery);
      const { kind } = imageParams.parse(request.params);
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
