import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticated } from './routes.js';
import type { IdentityService } from './identity.js';
import { AppError } from '../domain/errors.js';
import { profileInput, passwordInput, type ProfileService } from './profile.js';
import type { SessionService } from './sessions.js';

const none = z.object({}).strict();
const headers = z.object({ cookie: z.string().max(16384).optional() }).passthrough();
function validate(request: FastifyRequest) {
  none.parse(request.params ?? {});
  none.parse(request.query ?? {});
  headers.parse(request.headers);
}
export function registerProfile(
  app: FastifyInstance,
  profile: ProfileService,
  identity: IdentityService,
  sessions: Pick<SessionService, 'refreshPasswordHash'>,
) {
  const trace = (action: string) => ({
    config: { trace: { module: 'identity', resource: 'operator-profile', action } },
  });
  async function response(
    request: FastifyRequest,
    result: Awaited<ReturnType<ProfileService['update']>>,
  ) {
    // legacy update_session_auth_hash: the session that changed the password stays valid;
    // every other session of this user ends on its next request.
    if (result.password && request.authSessionId)
      await sessions.refreshPasswordHash(request.authSessionId, result.password);
    const user = await identity.get(authenticated(request).id);
    if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    request.principal = user;
    return { profile: result.profile, user, sessionExpiresAt: request.sessionExpiresAt };
  }
  app.get('/api/v1/operators/current/profile', trace('read'), async (request) => {
    validate(request);
    return {
      profile: await profile.get(authenticated(request)),
      sessionExpiresAt: request.sessionExpiresAt,
    };
  });
  app.patch('/api/v1/operators/current/profile', trace('update'), async (request) => {
    validate(request);
    return response(
      request,
      await profile.update(authenticated(request), profileInput.parse(request.body)),
    );
  });
  app.put('/api/v1/operators/current/password', trace('change-password'), async (request) => {
    validate(request);
    return response(
      request,
      await profile.changePassword(authenticated(request), passwordInput.parse(request.body)),
    );
  });
}
