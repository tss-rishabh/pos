import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { identifier } from '../domain/validation.js';
import { seal, unseal } from './crypto.js';
import type { SessionCredential, SessionService } from './sessions.js';

export const sessionCookieName = 'pos_session';
export const sessionTokenSchema = z
  .object({
    id: identifier,
    expires: z.number().int().positive(),
    sessionId: z.uuid(),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export function authCookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}
/** Install only a committed credential; an idempotent replay preserves itself. */
export async function writeSessionCookie(
  config: Config,
  sessions: SessionService,
  request: FastifyRequest,
  reply: FastifyReply,
  operatorId: string,
  credential: SessionCredential,
) {
  let prior: z.infer<typeof sessionTokenSchema> | undefined;
  try {
    prior = sessionTokenSchema.parse(
      unseal(request.cookies[sessionCookieName] ?? '', config.SESSION_SECRET),
    );
  } catch {
    /* A new or expired browser has no prior authenticated cookie. */
  }
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
