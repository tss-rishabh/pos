import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticated } from './routes.js';
import type { IdentityService } from './identity.js';
import type { Principal } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import { profileInput, passwordInput, type ProfileService } from './profile.js';

type RotateSession = (
  request: FastifyRequest,
  reply: FastifyReply,
  user: Principal,
  authVersion?: string,
) => Promise<number>;
export function registerProfile(
  app: FastifyInstance,
  profile: ProfileService,
  identity: IdentityService,
  rotateSession: RotateSession,
) {
  const trace = (action: string) => ({
    config: {
      trace: { module: 'identity', resource: 'operator-profile', action },
      rateLimit: { max: action === 'read' ? 30 : 5, timeWindow: '1 minute' },
    },
  });
  async function response(
    request: FastifyRequest,
    reply: FastifyReply,
    result: Awaited<ReturnType<ProfileService['update']>>,
  ) {
    const user = await identity.get(authenticated(request).id);
    if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    request.principal = user;
    const sessionExpiresAt = result.credentialsChanged
      ? await rotateSession(request, reply, user, result.authVersion)
      : request.sessionExpiresAt;
    return { profile: result.profile, user, sessionExpiresAt };
  }
  app.get('/api/v1/operators/current/profile', trace('read'), async (request) => ({
    profile: await profile.get(authenticated(request)),
    sessionExpiresAt: request.sessionExpiresAt,
  }));
  app.patch('/api/v1/operators/current/profile', trace('update'), async (request, reply) =>
    response(
      request,
      reply,
      await profile.update(authenticated(request), profileInput.parse(request.body)),
    ),
  );
  app.put('/api/v1/operators/current/password', trace('change-password'), async (request, reply) =>
    response(
      request,
      reply,
      await profile.changePassword(authenticated(request), passwordInput.parse(request.body)),
    ),
  );
}
