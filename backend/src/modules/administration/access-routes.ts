import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import type { administrationAccessService } from './access-control.js';
import {
  accessPageInput,
  administrationGroupDeleteInput,
  administrationGroupDeletionPreviewInput,
  administrationGroupBulkDeleteInput,
  administrationGroupInput,
  operatorAccessInput,
  permissionKey,
} from './access-domain.js';

const groupScope = z
    .object({ groupId: z.uuid().transform((value) => value.toLowerCase()) })
    .strict(),
  operatorScope = z.object({ operatorId: identifier }).strict();
const groupPage = accessPageInput.extend({ after: z.union([z.uuid(), z.literal('')]).default('') }),
  permissionPage = accessPageInput.extend({
    after: z.union([permissionKey, z.literal('')]).default(''),
  });
export function registerAdministrationAccess(
  app: FastifyInstance,
  service: ReturnType<typeof administrationAccessService>,
) {
  const trace = (resource: string, action: string) => ({
    config: {
      trace: { module: 'administration', resource, action },
      rateLimit: { max: action === 'list' || action === 'read' ? 60 : 10, timeWindow: '1 minute' },
    },
  });
  app.get(
    '/api/v1/admin/access/capabilities',
    trace('model-administration-access', 'read'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(await service.capabilities(authenticated(request))),
  );
  app.get(
    '/api/v1/admin/access/permissions',
    trace('model-administration-permission', 'list'),
    async (request, reply) =>
      reply.header('Cache-Control', 'private, no-store').send(
        await service.permissions(authenticated(request), {
          ...permissionPage.omit({ search: true }).parse(request.query),
          search: '',
        }),
      ),
  );
  app.get(
    '/api/v1/admin/access/groups',
    trace('model-administration-group', 'list'),
    async (request, reply) =>
      reply.header('Cache-Control', 'private, no-store').send(
        await service.groups(authenticated(request), {
          ...groupPage.omit({ search: true }).parse(request.query),
          search: '',
        }),
      ),
  );
  app.post(
    '/api/v1/admin/access/permissions/search',
    trace('model-administration-permission', 'search'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.permissions(authenticated(request), permissionPage.parse(request.body)),
        );
    },
  );
  app.post(
    '/api/v1/admin/access/groups/search',
    trace('model-administration-group', 'search'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.groups(authenticated(request), groupPage.parse(request.body)));
    },
  );
  app.get(
    '/api/v1/admin/access/groups/:groupId',
    trace('model-administration-group', 'read'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.group(authenticated(request), groupScope.parse(request.params).groupId),
        ),
  );
  app.post(
    '/api/v1/admin/access/groups',
    trace('model-administration-group', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .header('Cache-Control', 'no-store')
        .send(
          await service.saveGroup(
            authenticated(request),
            undefined,
            administrationGroupInput.parse(request.body),
          ),
        ),
  );
  app.put(
    '/api/v1/admin/access/groups/:groupId',
    trace('model-administration-group', 'update'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.saveGroup(
            authenticated(request),
            groupScope.parse(request.params).groupId,
            administrationGroupInput.parse(request.body),
          ),
        ),
  );
  app.delete(
    '/api/v1/admin/access/groups/:groupId',
    trace('model-administration-group', 'delete'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.deleteGroup(
            authenticated(request),
            groupScope.parse(request.params).groupId,
            administrationGroupDeleteInput.parse(request.body),
          ),
        ),
  );
  app.post(
    '/api/v1/admin/access/group-deletion-previews',
    trace('model-administration-group-selection', 'preview'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.previewGroupDeletion(
            authenticated(request),
            administrationGroupDeletionPreviewInput.parse(request.body),
          ),
        );
    },
  );
  app.post(
    '/api/v1/admin/access/group-deletions',
    trace('model-administration-group-selection', 'delete'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.deleteGroups(
            authenticated(request),
            administrationGroupBulkDeleteInput.parse(request.body),
          ),
        );
    },
  );
  app.get(
    '/api/v1/admin/operators/:operatorId/administration-access',
    trace('operator-administration-access', 'read'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.operator(
            authenticated(request),
            operatorScope.parse(request.params).operatorId,
          ),
        ),
  );
  app.put(
    '/api/v1/admin/operators/:operatorId/administration-access',
    trace('operator-administration-access', 'update'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.updateOperator(
            authenticated(request),
            operatorScope.parse(request.params).operatorId,
            operatorAccessInput.parse(request.body),
          ),
        ),
  );
}
