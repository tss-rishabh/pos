import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { identifier } from '../domain/validation.js';
import { seal, unseal } from './crypto.js';
import type { SessionCredential, SessionService } from './sessions.js';

export const sessionCookieName = 'pos_session';
export const pendingCookieName = 'pos_pending_login';
export const sessionTokenSchema = z
  .object({
    id: identifier,
    expires: z.number().int().positive(),
    sessionId: z.uuid(),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type SessionToken = z.infer<typeof sessionTokenSchema>;
/** HttpOnly; Secure unless SESSION_COOKIE_SECURE=false (local http only); SameSite=Lax (legacy default). */
export function authCookieOptions(config: Pick<Config, 'SESSION_COOKIE_SECURE'>) {
  return {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
  };
}
export function readSessionToken(
  request: FastifyRequest,
  config: Pick<Config, 'SESSION_SECRET'>,
): SessionToken | undefined {
  const raw = request.cookies[sessionCookieName];
  if (!raw) return undefined;
  try {
    return sessionTokenSchema.parse(unseal(raw, config.SESSION_SECRET));
  } catch {
    return undefined;
  }
}
/**
 * Installs a new session cookie. Like Django's `login()` cycling the session key, the
 * browser's previous session is deleted first.
 */
export async function writeSessionCookie(
  config: Pick<Config, 'SESSION_SECRET' | 'SESSION_COOKIE_SECURE'>,
  sessions: Pick<SessionService, 'revoke'>,
  request: FastifyRequest,
  reply: FastifyReply,
  operatorId: string,
  credential: SessionCredential,
) {
  const prior = readSessionToken(request, config);
  if (prior && prior.sessionId !== credential.sessionId) await sessions.revoke(prior.sessionId);
  reply.setCookie(
    sessionCookieName,
    seal({ id: operatorId, ...credential }, config.SESSION_SECRET),
    {
      ...authCookieOptions(config),
      maxAge: Math.max(0, Math.floor((credential.expires - Date.now()) / 1000)),
    },
  );
}
