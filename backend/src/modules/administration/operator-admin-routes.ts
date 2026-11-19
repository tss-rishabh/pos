import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import { identifier } from '../../domain/validation.js';
import {
  imageAttachmentInput,
  imageKind,
  imageReservationInput,
} from './image-lifecycle/domain.js';
import { operatorAdminPasswordInput, operatorAdminProfileInput } from './operator-admin-domain.js';
import type { operatorAdministrationService } from './operator-admin.js';

const scope = z.object({ operatorId: identifier }).strict();
const uploadScope = scope.extend({ uploadId: z.uuid() });
const imageScope = scope.extend({ kind: imageKind });
/** The admin client appends the image revision as a cache key (`?v=<revision>`). */
const imageQuery = z.strictObject({
  v: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export function registerOperatorAdministration(
  app: FastifyInstance,
  service: ReturnType<typeof operatorAdministrationService>,
) {
  const trace = (resource: string, action: string) => ({
    config: {
      trace: { module: 'administration', resource, action },
      rateLimit: { max: action === 'read' ? 60 : 10, timeWindow: '1 minute' },
    },
  });
  app.get(
    '/api/v1/admin/operator-administration/capabilities',
    {
      ...trace('operator-administration', 'capabilities'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.capabilities(authenticated(request)));
    },
  );
  app.get(
    '/api/v1/admin/operators/:operatorId/administrative-profile',
    {
      ...trace('operator-administrative-profile', 'read'),
      ...routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.profile(authenticated(request), scope.parse(request.params).operatorId),
        ),
  );
  app.put(
    '/api/v1/admin/operators/:operatorId/administrative-profile',
    {
      ...trace('operator-administrative-profile', 'update'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: operatorAdminProfileInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.updateProfile(
            authenticated(request),
            scope.parse(request.params).operatorId,
            operatorAdminProfileInput.parse(request.body),
          ),
        ),
  );
  app.post(
    '/api/v1/admin/operators/:operatorId/password-resets',
    {
      ...trace('operator-password-reset', 'create'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: operatorAdminPasswordInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.resetPassword(
            authenticated(request),
            scope.parse(request.params).operatorId,
            operatorAdminPasswordInput.parse(request.body),
          ),
        ),
  );
  app.post(
    '/api/v1/admin/operators/:operatorId/profile/image-uploads',
    {
      ...trace('operator-administrative-image', 'reserve'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: imageReservationInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.images.reserve(
            authenticated(request),
            scope.parse(request.params).operatorId,
            imageReservationInput.parse(request.body),
          ),
        ),
  );
  app.post(
    '/api/v1/admin/operators/:operatorId/profile/image-uploads/:uploadId/attachment',
    {
      ...trace('operator-administrative-image', 'attach'),
      ...routeSchema({
        params: uploadScope,
        querystring: noQuery,
        body: imageAttachmentInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      const { operatorId, uploadId } = uploadScope.parse(request.params),
        user = authenticated(request);
      await service.images.attach(
        user,
        operatorId,
        uploadId,
        imageAttachmentInput.parse(request.body).revision,
      );
      return reply
        .header('Cache-Control', 'no-store')
        .send({ profile: await service.profile(user, operatorId) });
    },
  );
  app.get(
    '/api/v1/admin/operators/:operatorId/profile/images/:kind',
    {
      ...trace('operator-administrative-image', 'read'),
      ...routeSchema({ params: imageScope, querystring: imageQuery, headers: transportHeaders }),
    },
    async (request, reply) => {
      const { operatorId, kind } = imageScope.parse(request.params),
        controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const image = await service.images.stream(
        authenticated(request),
        operatorId,
        kind,
        controller.signal,
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Type', image.contentType)
        .header('Content-Length', image.size!)
        .header('Content-Disposition', 'inline; filename="operator-image"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(image.body);
    },
  );
}
