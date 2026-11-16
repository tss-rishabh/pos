import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import {
  slackCallbackInput,
  startSlackConnectionInput,
  type slackConnectionService,
} from './slack-connections.js';

const scope = z.object({ storeId: identifier }).strict(),
  attempt = z.object({ connectionId: z.uuid() }).strict();
export function registerSlackConnections(
  app: FastifyInstance,
  config: Config,
  service: ReturnType<typeof slackConnectionService>,
) {
  const binding = (request: FastifyRequest) => {
    const cookie = request.cookies?.pos_session;
    if (!cookie) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return createHmac('sha256', config.SESSION_SECRET + ':slack-session-binding')
      .update(cookie)
      .digest('hex');
  };
  const trace = (action: string) => ({
    config: {
      trace: { module: 'administration', resource: 'store-slack-connection', action },
      rateLimit: { max: action === 'read' ? 60 : 10, timeWindow: '1 minute' },
    },
  });
  app.get('/api/v1/admin/stores/:storeId/slack-connection', trace('read'), async (request, reply) =>
    reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.view(authenticated(request), scope.parse(request.params).storeId)),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/slack-connections',
    trace('create'),
    async (request, reply) =>
      reply
        .code(201)
        .header('Cache-Control', 'no-store')
        .send(
          await service.start(
            authenticated(request),
            scope.parse(request.params).storeId,
            startSlackConnectionInput.parse(request.body),
            binding(request),
          ),
        ),
  );
  app.get('/api/v1/admin/slack/connections/:connectionId', trace('read'), async (request, reply) =>
    reply
      .header('Cache-Control', 'private, no-store')
      .send(
        await service.attempt(authenticated(request), attempt.parse(request.params).connectionId),
      ),
  );
  app.post(
    '/api/v1/admin/slack/connections/:connectionId/cancellation',
    trace('cancel'),
    async (request, reply) => {
      z.object({}).strict().parse(request.body);
      return reply
        .header('Cache-Control', 'no-store')
        .send(
          await service.cancel(authenticated(request), attempt.parse(request.params).connectionId),
        );
    },
  );
  app.get('/api/v1/admin/slack/oauth/callback', trace('complete'), async (request, reply) => {
    const result = await service.complete(
      authenticated(request),
      slackCallbackInput.parse(request.query),
      binding(request),
    );
    const target = new URL(config.WEB_ORIGIN);
    target.pathname = '/';
    target.search = new URLSearchParams({ slackConnection: result.id }).toString();
    return reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .redirect(target.href, 303);
  });
}
