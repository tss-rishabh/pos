import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { currentRequestTrace } from '../observability/context.js';

/** Registered identity events. Never carry OTPs, passwords, secrets, phones or emails. */
export const authEventIds = [
  'identity.login.password-rehashed',
  'identity.login.unverifiable-password-hash',
  'identity.login-otp.issued',
  'identity.login-otp.fixed-issued',
  'identity.login-otp.contact-missing',
  'identity.login-otp.email-failed',
  'identity.login-otp.sms-failed',
  'identity.login-otp.whatsapp-failed',
  'identity.login-otp.locked',
  'identity.login-otp.verification-failed',
  'identity.login-otp.totp-unavailable',
  'identity.login-otp.alert-failed',
  'identity.session.logout-check-in-cleanup-failed',
] as const;
export type AuthEventId = (typeof authEventIds)[number];
export interface AuthEvent {
  eventId: AuthEventId;
  userId: string | null;
  errorCode?: string;
  level?: 'info' | 'warn' | 'error';
}
export type AuthEventLogger = (event: AuthEvent) => void;
export function authEventLogger(log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>) {
  return (event: AuthEvent) => {
    const trace = currentRequestTrace(),
      [, resource = 'authentication'] = event.eventId.split('.');
    log[event.level ?? 'info'](
      {
        eventId: event.eventId,
        eventInstanceId: randomUUID(),
        module: 'identity',
        resource,
        requestId: trace?.requestId ?? null,
        traceId: trace?.requestId ?? null,
        userId: event.userId,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      },
      'Identity event',
    );
  };
}
export const silentAuthEvents: AuthEventLogger = () => {};
