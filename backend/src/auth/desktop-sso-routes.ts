import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';
import { seal, unseal } from './crypto.js';
import {
  desktopSsoApproval,
  desktopSsoClientProof,
  type DesktopSsoService,
} from './desktop-sso.js';
import { writeSessionCookie, authCookieOptions } from './session-cookies.js';
import type { SessionService } from './sessions.js';

export const desktopApprovalCookieName = 'pos_desktop_sso';
export const desktopApprovalCookiePath = '/api/v1/auth/desktop-sso';
export const desktopClientCookieName = 'pos_desktop_sso_client';
export const desktopClientCookiePath = '/api/v1/auth/desktop-sso-sessions';
const params = z.object({ id: z.uuid() }).strict();
const empty = z.object({}).strict();
function clientProof(config: Config, request: FastifyRequest) {
  try {
    const value = desktopSsoClientProof.parse(
      unseal(request.cookies[desktopClientCookieName] ?? '', config.SESSION_SECRET),
    );
    if (value.expires <= Date.now()) throw new Error('Expired desktop flow');
    return value;
  } catch {
    throw new AppError(401, 'DESKTOP_SSO_CLIENT_EXPIRED', 'Start a new desktop sign-in.');
  }
}
function proof(config: Config, request: FastifyRequest, id: string) {
  const value = clientProof(config, request);
  if (value.id !== id)
    throw new AppError(401, 'DESKTOP_SSO_CLIENT_EXPIRED', 'Start a new desktop sign-in.');
  return value.secret;
}
function browserProof(config: Config, request: FastifyRequest) {
  try {
    return desktopSsoApproval.parse(
      unseal(request.cookies[desktopApprovalCookieName] ?? '', config.SESSION_SECRET),
    );
  } catch {
    throw new AppError(
      401,
      'DESKTOP_SSO_APPROVAL_EXPIRED',
      'Start sign-in from the POS desktop app.',
    );
  }
}
function origin(config: Config, request: FastifyRequest) {
  if (request.headers.origin !== new URL(config.WEB_ORIGIN).origin)
    throw new AppError(403, 'ORIGIN_DENIED', 'Request origin is not allowed.');
}
export function registerDesktopSso(
  app: FastifyInstance,
  config: Config,
  service: DesktopSsoService,
  sessions: SessionService,
) {
  const trace = (resource: string, action: string) => ({ module: 'identity', resource, action });
  app.post(
    '/api/v1/auth/desktop-sso-sessions',
    {
      config: {
        trace: trace('desktop-sso-session', 'create'),
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      origin(config, request);
      empty.parse(request.query);
      empty.parse(request.body);
      const flow = await service.create();
      const browser = new URL('/api/v1/auth/sso/login', config.WEB_ORIGIN);
      browser.search = new URLSearchParams({ desktop: flow.id, ticket: flow.ticket }).toString();
      reply.setCookie(
        desktopClientCookieName,
        seal(
          {
            purpose: 'desktop-sso-client',
            id: flow.id,
            secret: flow.secret,
            expires: flow.expires,
          },
          config.SESSION_SECRET,
        ),
        {
          ...authCookieOptions(config),
          path: desktopClientCookiePath,
          maxAge: Math.max(0, Math.floor((flow.expires - Date.now()) / 1000)),
        },
      );
      return reply.header('Cache-Control', 'private, no-store').send({
        id: flow.id,
        code: flow.code,
        expires: flow.expires,
        browserUrl: browser.href,
      });
    },
  );
  app.get(
    '/api/v1/auth/desktop-sso-sessions/current',
    {
      config: {
        trace: trace('desktop-sso-session', 'recover-current'),
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      empty.parse(request.query);
      const value = clientProof(config, request);
      const result = await service.status(value.id, value.secret);
      return reply.header('Cache-Control', 'private, no-store').send({
        id: value.id,
        status: result.status,
        expires: result.expires,
      });
    },
  );
  app.get(
    '/api/v1/auth/desktop-sso-sessions/:id',
    {
      config: {
        trace: trace('desktop-sso-session', 'read'),
        rateLimit: { max: 90, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      empty.parse(request.query);
      const { id } = params.parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.status(id, proof(config, request, id)));
    },
  );
  app.post(
    '/api/v1/auth/desktop-sso-sessions/:id/consumptions',
    {
      config: {
        trace: trace('desktop-sso-consumption', 'create'),
        rateLimit: { max: 15, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      origin(config, request);
      empty.parse(request.query);
      empty.parse(request.body);
      const { id } = params.parse(request.params);
      const result = await service.consume(id, proof(config, request, id));
      await writeSessionCookie(config, sessions, request, reply, result.user.id, result.credential);
      request.principal = result.user;
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ user: result.user, sessionExpiresAt: result.credential.expires });
    },
  );
  app.post(
    '/api/v1/auth/desktop-sso-sessions/:id/cancellations',
    {
      config: {
        trace: trace('desktop-sso-cancellation', 'create'),
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      origin(config, request);
      empty.parse(request.query);
      empty.parse(request.body);
      const { id } = params.parse(request.params);
      const result = await service.cancel(id, proof(config, request, id));
      reply.clearCookie(desktopClientCookieName, {
        ...authCookieOptions(config),
        path: desktopClientCookiePath,
      });
      return reply.header('Cache-Control', 'private, no-store').send(result);
    },
  );
  app.get(
    '/api/v1/auth/desktop-sso/approval',
    {
      config: {
        trace: trace('desktop-sso-approval', 'read'),
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      empty.parse(request.query);
      const result = await service.approval(browserProof(config, request));
      request.principal = result.user;
      return reply.header('Cache-Control', 'private, no-store').send(result);
    },
  );
  app.post(
    '/api/v1/auth/desktop-sso/approval',
    {
      config: {
        trace: trace('desktop-sso-approval', 'create'),
        rateLimit: { max: 15, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      origin(config, request);
      empty.parse(request.query);
      const result = await service.approve(
        browserProof(config, request),
        z
          .object({ code: z.string().regex(/^\d{6}$/) })
          .strict()
          .parse(request.body).code,
      );
      request.principal = result.user;
      return reply.header('Cache-Control', 'private, no-store').send({ approved: true });
    },
  );
}
export function setDesktopApprovalCookie(
  config: Config,
  reply: FastifyReply,
  approval: z.infer<typeof desktopSsoApproval>,
) {
  reply.setCookie(desktopApprovalCookieName, seal(approval, config.SESSION_SECRET), {
    ...authCookieOptions(config),
    path: desktopApprovalCookiePath,
    maxAge: Math.max(0, Math.floor((approval.expires - Date.now()) / 1000)),
  });
}
