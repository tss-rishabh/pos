import type {} from '@fastify/cookie';
import type { Principal } from './domain/access.js';
import type { SessionTransaction } from './auth/sessions.js';

export interface ResourceTrace {
  module: string;
  resource: string;
  action: string;
}

/** Shared type contract: isolated consumers must not need auth/plugin startup
 * imports merely to understand request identity and resource tracing. */
declare module 'fastify' {
  interface FastifyContextConfig {
    trace?: ResourceTrace;
    authentication?: 'session' | 'service';
  }
  interface FastifyRequest {
    principal: Principal | null;
    sessionExpiresAt: number | null;
    authSessionId: string | null;
    authSessionValid: ((transaction?: SessionTransaction) => Promise<boolean>) | null;
    auditUserId: string | null;
  }
}
