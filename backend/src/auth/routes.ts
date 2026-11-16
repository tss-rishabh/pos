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
  googleSsoConfigured,
  googleSsoProvider,
  newSsoState,
  ssoStateSchema,
  type GoogleSsoProvider,
} from './google-sso.js';
import {
  authCookieOptions,
  sessionCookieName,
  sessionTokenSchema,
  writeSessionCookie,
} from './session-cookies.js';
import { desktopSsoSecret, type DesktopSsoService } from './desktop-sso.js';
import {
  desktopApprovalCookieName,
  desktopApprovalCookiePath,
  desktopClientCookieName,
  desktopClientCookiePath,
  setDesktopApprovalCookie,
} from './desktop-sso-routes.js';

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
  options: { sso?: GoogleSsoProvider; desktopSso?: DesktopSsoService } = {},
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
  const sso = options.sso ?? googleSsoProvider(config);
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
    request.authSessionValid = () => sessions.valid(parsed.id, parsed);
    request.principal =
      config.DEMO_MODE && parsed.id === demoUser.id ? demoUser : await identity.get(parsed.id);
    request.sessionExpiresAt = parsed.expires;
  });
  app.get('/api/v1/auth/capabilities', async () => ({
    password: !config.DEMO_MODE,
    sso: !config.DEMO_MODE && googleSsoConfigured(config),
    desktopSso: options.desktopSso?.available ?? false,
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
    reply.clearCookie('pos_oidc', { ...cookieOptions, path: '/api/v1/auth' });
    reply.clearCookie(desktopApprovalCookieName, {
      ...cookieOptions,
      path: desktopApprovalCookiePath,
    });
    reply.clearCookie(desktopClientCookieName, { ...cookieOptions, path: desktopClientCookiePath });
    reply.code(204).send();
  });
  app.get(
    '/api/v1/auth/sso/login',
    {
      config: {
        trace: { module: 'identity', resource: 'sso-authorization', action: 'create' },
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (_request, reply) => {
      const query = z
        .object({ desktop: z.uuid().optional(), ticket: desktopSsoSecret.optional() })
        .strict()
        .refine((value) => Boolean(value.desktop) === Boolean(value.ticket))
        .parse(_request.query);
      if (query.desktop && !options.desktopSso?.available)
        throw new AppError(
          503,
          'DESKTOP_SSO_UNAVAILABLE',
          'Desktop Google sign-in is unavailable.',
        );
      const state = {
        ...newSsoState(),
        ...(query.desktop ? { desktopFlowId: query.desktop } : {}),
      };
      const url = await sso.authorization(state);
      if (query.desktop && query.ticket) {
        const started = await options.desktopSso!.start(query.desktop, query.ticket);
        state.expires = Math.min(state.expires, started.expires);
      }
      reply.setCookie('pos_oidc', seal(state, config.SESSION_SECRET), {
        ...cookieOptions,
        path: '/api/v1/auth',
        maxAge: Math.max(0, Math.floor((state.expires - Date.now()) / 1000)),
      });
      return reply.redirect(url.href);
    },
  );
  app.get(
    '/api/v1/auth/sso/callback',
    {
      config: {
        trace: { module: 'identity', resource: 'sso-callback', action: 'verify' },
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      let state;
      try {
        state = ssoStateSchema.parse(unseal(request.cookies.pos_oidc || '', config.SESSION_SECRET));
      } catch {
        throw new AppError(400, 'INVALID_SSO_STATE', 'SSO session expired. Please sign in again.');
      }
      reply.clearCookie('pos_oidc', { ...cookieOptions, path: '/api/v1/auth' });
      if (state.expires <= Date.now())
        throw new AppError(400, 'INVALID_SSO_STATE', 'SSO session expired.');
      const callback = new URL(config.OIDC_REDIRECT_URI!);
      callback.search = new URL(request.url, 'http://local').search;
      const verified = await sso.verify(callback, state);
      if (!identity.byGoogleIdentity)
        throw new AppError(503, 'SSO_UNAVAILABLE', 'Google identity linking is unavailable.');
      const account = await identity.byGoogleIdentity(verified);
      if (!account)
        throw new AppError(
          403,
          'ACCOUNT_NOT_PROVISIONED',
          'Ask your administrator to provision your POS account.',
        );
      if (account.user.email.toLowerCase() !== verified.email)
        throw new AppError(
          403,
          'SSO_ACCOUNT_CHANGED',
          'Your account changed. Start sign-in again.',
        );
      request.principal = account.user;
      if (state.desktopFlowId) {
        if (!options.desktopSso)
          throw new AppError(
            503,
            'DESKTOP_SSO_UNAVAILABLE',
            'Desktop Google sign-in is unavailable.',
          );
        setDesktopApprovalCookie(
          config,
          reply,
          await options.desktopSso.bindIdentity(state.desktopFlowId, account),
        );
        return reply.redirect(new URL('/desktop-sign-in', config.WEB_ORIGIN).href);
      }
      await session(request, reply, account.user, account.authVersion, true);
      return reply.redirect(new URL('/', config.WEB_ORIGIN).href);
    },
  );
  return { rotateSession: session };
}
export function authenticated(request: FastifyRequest): Principal {
  if (!request.principal) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return request.principal;
}
