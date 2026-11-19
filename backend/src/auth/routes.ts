import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {} from '../fastify-extensions.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Principal } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import { noBody, requestHeaders, routeSchema } from '../domain/route-validation.js';
import { seal, unseal } from './crypto.js';
import type { IdentityService } from './identity.js';
import type { LoginCheckIns } from './checkin.js';
import type { AuthEventLogger } from './events.js';
import {
  expiredLogin,
  verificationInput,
  type LoginChallengeService,
  type PendingLogin,
} from './mfa.js';
import { endOfDaySeconds, type SessionService } from './sessions.js';
import {
  authCookieOptions,
  pendingCookieName,
  readSessionToken,
  sessionCookieName,
  writeSessionCookie,
} from './session-cookies.js';

const pendingSchema = z
  .object({
    id: z.uuid(),
    secret: z.string().regex(/^[\w-]{43}$/),
    expires: z.number().int().positive(),
  })
  .strict();
const noParams = z.object({}).strict();
const noQuery = z.object({}).strict();
/** Only the headers auth routes read; values are bounded and never logged. */
const authHeaders = requestHeaders({
  cookie: z.string().max(16384).optional(),
  origin: z.string().max(2048).optional(),
  'content-type': z.string().max(256).optional(),
});
const passwordStep = z
  .object({
    // AuthenticationForm: username max_length = pos_user.username (150); password not stripped.
    username: z.string().max(254),
    password: z.string().max(4096),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.username.trim())
      context.addIssue({
        code: 'custom',
        path: ['username'],
        message: 'Enter your username or email.',
      });
    if (!input.password)
      context.addIssue({ code: 'custom', path: ['password'], message: 'Enter your password.' });
  });
const emptyBody = z.object({}).strict();
/**
 * Declared gate for the auth routes. A missing body (`null`) passes the gate so the handler's
 * `validate` reports the same field issues it always has for an absent body.
 */
const authSchema = (body?: z.ZodType) =>
  routeSchema({
    querystring: noQuery,
    headers: authHeaders,
    ...(body ? { body: body.nullable() } : {}),
  });
function validate(request: FastifyRequest, body?: z.ZodType) {
  noParams.parse(request.params ?? {});
  noQuery.parse(request.query ?? {});
  authHeaders.parse(request.headers);
  return body ? body.parse(request.body ?? {}) : undefined;
}
export interface AuthRouteOptions {
  config: Config;
  identity: IdentityService;
  sessions: SessionService;
  challenges: LoginChallengeService;
  checkIns: LoginCheckIns;
  log: AuthEventLogger;
  /** Isolated demo workspace only (DEMO_MODE, refused in production). */
  demoUser?: Principal;
}
export function registerAuth(app: FastifyInstance, options: AuthRouteOptions) {
  const { config, identity, sessions, challenges, checkIns, log } = options;
  const cookieOptions = authCookieOptions(config);
  const pendingCookie = { ...cookieOptions, path: '/api/v1/auth' };
  const demoUser = config.DEMO_MODE ? options.demoUser : undefined;
  async function startSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: Principal,
  ): Promise<number> {
    const credential = await sessions.create(
      user.id,
      Date.now() + endOfDaySeconds(config.BUSINESS_TIMEZONE) * 1000,
    );
    await writeSessionCookie(config, sessions, request, reply, user.id, credential);
    return credential.expires;
  }
  function pendingCredential(request: FastifyRequest): PendingLogin {
    try {
      return pendingSchema.parse(
        unseal(request.cookies[pendingCookieName] || '', config.SESSION_SECRET),
      );
    } catch {
      throw expiredLogin();
    }
  }
  app.decorateRequest('principal', null);
  app.decorateRequest('sessionExpiresAt', null);
  app.decorateRequest('authSessionId', null);
  app.decorateRequest('authSessionValid', null);
  app.decorateRequest('auditUserId', null);
  /**
   * S50: the session is resolved in `onRequest`, before body parsing and zod validation, and a
   * route that requires a session (the default) answers 401 here. Unauthenticated callers never
   * reach the schema, so they never see a shape error. `public` routes (login, health) resolve a
   * session when present and validate first; `service` routes check their own secret.
   */
  app.addHook('onRequest', async (request) => {
    const mode = request.routeOptions.config.authentication ?? 'session';
    if (mode === 'service') return;
    await resolveSession(request);
    if (
      mode === 'session' &&
      !request.principal &&
      request.routeOptions.url !== undefined &&
      request.method !== 'OPTIONS'
    )
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  });
  async function resolveSession(request: FastifyRequest) {
    const token = readSessionToken(request, config);
    if (!token) return;
    // Legacy AuthenticationMiddleware: the user row is re-read on every request and the
    // session ends when the user is inactive or the password hash changed.
    const account = await sessions.resolve(token.id, token);
    if (!account) return;
    const principal =
      demoUser && token.id === demoUser.id ? demoUser : await identity.principal(account);
    if (!principal) return;
    request.authSessionId = token.sessionId;
    request.authSessionValid = (transaction) => sessions.valid(token.id, token, transaction);
    request.principal = principal;
    request.sessionExpiresAt = token.expires;
  }
  // Login-challenge routes run before a session exists.
  const trace = (resource: string, action: string, body?: z.ZodType) => ({
    config: { trace: { module: 'identity', resource, action }, authentication: 'public' as const },
    ...authSchema(body),
  });
  const publicRoute = { config: { authentication: 'public' as const } };
  app.get('/api/v1/auth/capabilities', { ...publicRoute, ...authSchema() }, async (request) => {
    validate(request);
    return { password: !demoUser, demo: Boolean(demoUser) };
  });
  /** Password step (legacy CustomLoginView.post). */
  const passwordRoute = { ...publicRoute, ...authSchema(passwordStep) };
  app.post('/api/v1/auth/sessions', passwordRoute, async (request, reply) => {
    const body = validate(request, passwordStep) as z.infer<typeof passwordStep>;
    const previous = request.cookies[pendingCookieName];
    reply.clearCookie(pendingCookieName, pendingCookie);
    if (previous)
      try {
        await challenges.discard(pendingSchema.parse(unseal(previous, config.SESSION_SECRET)));
      } catch {
        /* An unreadable cookie identifies no pending login. */
      }
    if (demoUser)
      throw new AppError(
        404,
        'NOT_FOUND',
        'Password sign-in is unavailable in the demo workspace.',
      );
    const account = await identity.authenticate(body.username, body.password);
    if (!account)
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'The username or email and password do not match an active account. Both fields may be case-sensitive.',
      );
    request.auditUserId = String(account.id);
    if (!(await identity.principal(account)))
      throw new AppError(
        403,
        'ACCOUNT_ROLE_UNSUPPORTED',
        'This account has a role or user type the POS cannot use. Ask an administrator to correct it.',
      );
    const pending = await challenges.begin(account);
    reply.setCookie(pendingCookieName, seal(pending.credential, config.SESSION_SECRET), {
      ...pendingCookie,
      maxAge: config.LOGIN_MFA_PENDING_TTL,
    });
    return reply.code(202).send(pending.view);
  });
  app.get('/api/v1/auth/challenges/current', trace('login-challenge', 'read'), async (request) => {
    validate(request);
    return challenges.describe(pendingCredential(request), (userId) => {
      request.auditUserId = userId;
    });
  });
  /** legacy AjaxSendLoginOtpView. */
  app.post(
    '/api/v1/auth/challenges/current/resends',
    trace('login-challenge', 'resend', emptyBody),
    async (request) => {
      validate(request, emptyBody);
      const credential = pendingCredential(request);
      const sent = await challenges.resend(credential, (userId) => {
        request.auditUserId = userId;
      });
      return { ...(await challenges.describe(credential)), message: sent.otpMethodMessage };
    },
  );
  /** legacy AjaxMfaLoginView: verify, check in, sign in. */
  app.post(
    '/api/v1/auth/challenges/current/verifications',
    trace('login-challenge', 'verify', verificationInput),
    async (request, reply) => {
      const input = validate(request, verificationInput) as z.infer<typeof verificationInput>;
      const credential = pendingCredential(request);
      const { row, storeId } = await challenges.verify(credential, input, (userId) => {
        request.auditUserId = userId;
      });
      const user = await identity.principal(row);
      if (!user) throw expiredLogin();
      const sessionExpiresAt = await startSession(request, reply, user);
      reply.clearCookie(pendingCookieName, pendingCookie);
      request.principal = user;
      await identity.recordLogin(user.id);
      const eod = Math.max(1, Math.floor((sessionExpiresAt - Date.now()) / 1000));
      await checkIns.record(user.id, storeId, eod);
      return { user, sessionExpiresAt, checkInStoreId: storeId };
    },
  );
  // These two routes read no body; the clients send none.
  const bodyless = {
    ...publicRoute,
    ...routeSchema({ querystring: noQuery, body: noBody, headers: authHeaders }),
  };
  app.post('/api/v1/auth/demo-sessions', bodyless, async (request, reply) => {
    validate(request);
    if (!demoUser) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    request.principal = demoUser;
    const sessionExpiresAt = await startSession(request, reply, demoUser);
    return { user: demoUser, sessionExpiresAt };
  });
  app.get('/api/v1/auth/sessions/current', authSchema(), async (request) => {
    validate(request);
    return { user: authenticated(request), sessionExpiresAt: request.sessionExpiresAt };
  });
  /** legacy CustomLogoutView. */
  app.delete('/api/v1/auth/sessions/current', bodyless, async (request, reply) => {
    validate(request);
    const token = readSessionToken(request, config);
    if (token) {
      const account = await sessions.resolve(token.id, token);
      await sessions.revoke(token.sessionId);
      if (account && !demoUser)
        try {
          await checkIns.leaveLists(token.id);
        } catch {
          log({
            eventId: 'identity.session.logout-check-in-cleanup-failed',
            userId: token.id,
            level: 'warn',
          });
        }
    }
    const pending = request.cookies[pendingCookieName];
    if (pending)
      try {
        await challenges.discard(pendingSchema.parse(unseal(pending, config.SESSION_SECRET)));
      } catch {
        /* An unreadable cookie identifies no pending login. */
      }
    reply.clearCookie(sessionCookieName, cookieOptions);
    reply.clearCookie(pendingCookieName, pendingCookie);
    return reply.code(204).send();
  });
  return { sessions };
}
export function authenticated(request: FastifyRequest): Principal {
  if (!request.principal) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return request.principal;
}
