import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {} from '../fastify-extensions.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { IdentityService } from './identity.js';
import type { Principal } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import { seal, unseal } from './crypto.js';
import type { SessionService } from './sessions.js';
import type { LoginChallengeService } from './mfa.js';
import { identifier } from '../domain/validation.js';
import { Temporal } from '@js-temporal/polyfill';
import {
  authCookieOptions,
  sessionCookieName,
  sessionTokenSchema,
  writeSessionCookie,
} from './session-cookies.js';

const cookieName = sessionCookieName;
const pendingCookieName = 'pos_pending_login';
const pendingSchema = z
  .object({
    id: z.uuid(),
    secret: z.string().regex(/^[\w-]{43}$/),
    expires: z.number().int().positive(),
  })
  .strict();
const tokenSchema = sessionTokenSchema;
export function registerAuth(
  app: FastifyInstance,
  config: Config,
  identity: IdentityService,
  demoUser: Principal,
  sessions: SessionService,
  challenges: LoginChallengeService,
) {
  const cookieOptions = authCookieOptions(config);
  async function session(
    request: FastifyRequest,
    reply: FastifyReply,
    user: Principal,
    authVersion?: string,
    recordLogin = false,
  ) {
    const expires = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .startOfDay()
      .add({ days: 1 })
      .toInstant()
      .subtract({ seconds: 1 }).epochMilliseconds;
    const credential = await sessions.create(
      user.id,
      expires,
      authVersion,
      recordLogin
        ? Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
            .toPlainDateTime()
            .toString({ smallestUnit: 'second' })
            .replace('T', ' ')
        : undefined,
    );
    await writeSessionCookie(config, sessions, request, reply, user.id, credential);
    return credential.expires;
  }
  app.decorateRequest('principal', null);
  app.decorateRequest('sessionExpiresAt', null);
  app.decorateRequest('authSessionId', null);
  app.decorateRequest('authSessionValid', null);
  app.decorateRequest('auditUserId', null);
  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.config.authentication === 'service') return;
    const token = request.cookies[cookieName];
    if (!token) return;
    let parsed;
    try {
      parsed = tokenSchema.parse(unseal(token, config.SESSION_SECRET));
    } catch {
      return;
    }
    if (!(await sessions.valid(parsed.id, parsed))) return;
    request.authSessionId = parsed.sessionId;
    request.authSessionValid = (transaction) => sessions.valid(parsed.id, parsed, transaction);
    request.principal =
      config.DEMO_MODE && parsed.id === demoUser.id ? demoUser : await identity.get(parsed.id);
    request.sessionExpiresAt = parsed.expires;
  });
  app.get('/api/v1/auth/capabilities', async () => ({
    password: !config.DEMO_MODE,
    demo: config.DEMO_MODE,
  }));
  app.post(
    '/api/v1/auth/sessions',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.clearCookie(pendingCookieName, { ...cookieOptions, path: '/api/v1/auth' });
      const body = z
        .object({ username: z.string().min(1).max(254), password: z.string().min(1).max(512) })
        .strict()
        .parse(request.body);
      const account = await identity.login(body.username, body.password);
      request.auditUserId = account.user.id;
      const pending = await challenges.begin(account);
      reply.setCookie(pendingCookieName, seal(pending.credential, config.SESSION_SECRET), {
        ...cookieOptions,
        path: '/api/v1/auth',
        maxAge: config.LOGIN_MFA_PENDING_TTL,
      });
      return reply.code(202).send(pending.view);
    },
  );
  function pendingCredential(request: FastifyRequest) {
    try {
      return pendingSchema.parse(
        unseal(request.cookies[pendingCookieName] || '', config.SESSION_SECRET),
      );
    } catch {
      throw new AppError(401, 'LOGIN_CHALLENGE_EXPIRED', 'Sign in with your password again.');
    }
  }
  const challengeTrace = (action: string) => ({
    config: {
      trace: { module: 'identity', resource: 'login-challenge', action },
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  });
  app.get('/api/v1/auth/challenges/current', challengeTrace('read'), async (request) =>
    challenges.describe(pendingCredential(request), 'existing', (userId) => {
      request.auditUserId = userId;
    }),
  );
  app.post('/api/v1/auth/challenges/current/resends', challengeTrace('resend'), async (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return challenges.resend(pendingCredential(request), (userId) => {
      request.auditUserId = userId;
    });
  });
  app.post(
    '/api/v1/auth/challenges/current/verifications',
    challengeTrace('verify'),
    async (request, reply) => {
      const input = z
        .object({
          code: z.string().regex(/^\d{6}$/),
          factor: z.enum(['otp', 'totp']),
          storeId: identifier,
        })
        .strict()
        .parse(request.body);
      const { user, authVersion } = await challenges.verify(
        pendingCredential(request),
        input.code,
        input.factor,
        input.storeId,
        (userId) => {
          request.auditUserId = userId;
        },
      );
      request.principal = user;
      const sessionExpiresAt = await session(request, reply, user, authVersion, true);
      reply.clearCookie(pendingCookieName, { ...cookieOptions, path: '/api/v1/auth' });
      return { user, sessionExpiresAt };
    },
  );
  app.post('/api/v1/auth/demo-sessions', async (request, reply) => {
    if (!config.DEMO_MODE) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    request.principal = demoUser;
    const sessionExpiresAt = await session(request, reply, demoUser);
    return { user: demoUser, sessionExpiresAt };
  });
  app.get('/api/v1/auth/sessions/current', async (request) => ({
    user: authenticated(request),
    sessionExpiresAt: request.sessionExpiresAt,
  }));
  app.delete('/api/v1/auth/sessions/current', async (request, reply) => {
    const token = request.cookies[cookieName];
    let parsed: z.infer<typeof tokenSchema> | undefined;
    try {
      if (token) parsed = tokenSchema.parse(unseal(token, config.SESSION_SECRET));
    } catch {
      /* Invalid cookies cannot identify a server session. */
    }
    if (parsed) await sessions.revoke(parsed.sessionId);
    let pending: z.infer<typeof pendingSchema> | undefined;
    try {
      if (request.cookies[pendingCookieName])
        pending = pendingSchema.parse(
          unseal(request.cookies[pendingCookieName]!, config.SESSION_SECRET),
        );
    } catch {
      /* Invalid cookies cannot identify a login proof. */
    }
    if (pending && !config.DEMO_MODE) await challenges.discard(pending);
    reply.clearCookie(cookieName, cookieOptions);
    reply.clearCookie(pendingCookieName, { ...cookieOptions, path: '/api/v1/auth' });
    reply.code(204).send();
  });
  return { rotateSession: session };
}
export function authenticated(request: FastifyRequest): Principal {
  if (!request.principal) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return request.principal;
}
