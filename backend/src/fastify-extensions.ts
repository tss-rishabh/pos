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
    /**
     * `session` (default): a signed-in operator is required, checked in `onRequest` before input
     * validation (S50). `public`: the session is read when present but not required (login,
     * health). `service`: no session; the route checks its own secret or proof.
     */
    authentication?: 'session' | 'service' | 'public';
  }
  interface FastifyRequest {
    principal: Principal | null;
    sessionExpiresAt: number | null;
    authSessionId: string | null;
    authSessionValid: ((transaction?: SessionTransaction) => Promise<boolean>) | null;
    auditUserId: string | null;
  }
}
