import { and, asc, eq, lte, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../db/pools.js';
import { AppError } from '../domain/errors.js';
import { boundedText } from '../domain/http-json.js';
import { securityAlerts } from './security-schema.js';
import { loginChallenges, loginSecurity } from './mfa-schema.js';
import { pruneExpiredSessions } from './sessions.js';
import { retryTransaction } from '../db/retry.js';
import { pruneOperatorMfaEnrollments } from '../modules/administration/mfa.js';
import { pruneSlackConnections } from '../modules/administration/slack-connections.js';
import { pruneApplicationLinks } from '../modules/application-links/service.js';

const enabled = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
export function securityWorkerOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      AUTH_SECURITY_WORKER_ENABLED: enabled,
      AUTH_SECURITY_POLL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
      AUTH_SECURITY_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(5),
      LOGIN_SECURITY_SLACK_WEBHOOK: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.url().optional(),
      ),
    })
    .parse(env);
}
export interface SecurityWorkerEvent {
  module: 'identity';
  resource: 'login-security-alert' | 'login-security-worker';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  alertId?: string;
  attempt?: number;
  errorCode?: string;
}
export type SecurityWorkerLogger = (event: SecurityWorkerEvent) => void;
type Alert = typeof securityAlerts.$inferSelect;
export function securityAlertWorker(
  db: Databases,
  options: ReturnType<typeof securityWorkerOptions>,
  log: SecurityWorkerLogger,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  let webhook: URL | undefined;
  if (options.LOGIN_SECURITY_SLACK_WEBHOOK) {
    webhook = new URL(options.LOGIN_SECURITY_SLACK_WEBHOOK);
    if (
      webhook.protocol !== 'https:' ||
      !['hooks.slack.com', 'hooks.slack-gov.com'].includes(webhook.hostname) ||
      webhook.username ||
      webhook.password ||
      webhook.search ||
      webhook.hash
    )
      throw new AppError(
        503,
        'SECURITY_ALERT_CONFIGURATION_INVALID',
        'Configure an approved login-security webhook.',
      );
  }
  if (options.AUTH_SECURITY_WORKER_ENABLED && !webhook)
    throw new AppError(
      503,
      'SECURITY_ALERT_CONFIGURATION_REQUIRED',
      'Configure the login-security webhook before enabling this worker.',
    );
  const abort = new AbortController();
  let active: Promise<number> | undefined,
    stopPromise: Promise<void> | undefined,
    stopping = false,
    lastCleanup = 0;
  function event(action: string, job?: Alert, errorCode?: string): SecurityWorkerEvent {
    return {
      module: 'identity',
      resource: job ? 'login-security-alert' : 'login-security-worker',
      eventId: `identity.${job ? 'login-security-alert' : 'login-security-worker'}.${action}`,
      eventInstanceId: crypto.randomUUID(),
      requestId: job?.requestId || null,
      userId: job?.userId || null,
      ...(job ? { alertId: job.id, attempt: job.attempts } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }
  async function deliver(job: Alert) {
    let acknowledged = false,
      wait = 1000 * Math.min(3600, 2 ** Math.min(job.attempts, 10));
    if (!stopping) {
      try {
        const response = await fetcher(webhook!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `Staff login security alert ${job.id}: user_id ${job.userId} locked until ${job.lockedUntil.toISOString()} after ${job.failedAttempts} wrong ${job.factor.toUpperCase()} attempts.`,
          }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          redirect: 'error',
        });
        if (response.status === 429) {
          const after = Number(response.headers.get('Retry-After'));
          if (Number.isFinite(after) && after > 0) wait = Math.min(3600, after) * 1000;
        }
        if (response.ok) acknowledged = (await boundedText(response, 1024)).trim() === 'ok';
        else await response.body?.cancel();
      } catch {
        /* Provider payloads, webhook URLs and transport errors never reach logs. */
      }
    }
    await retryTransaction(() =>
      db.get('writer').transaction(async (transaction) => {
        const condition = and(
          eq(securityAlerts.id, job.id),
          eq(securityAlerts.state, 'dispatching'),
          eq(securityAlerts.leaseToken, job.leaseToken!),
        );
        const [owned] = await transaction
          .select({ id: securityAlerts.id })
          .from(securityAlerts)
          .where(condition)
          .limit(1)
          .for('update');
        if (!owned) return;
        await transaction
          .update(securityAlerts)
          .set({
            state: acknowledged ? 'sent' : job.attempts >= 10 ? 'failed' : 'pending',
            availableAt: new Date(now() + wait),
            leaseToken: null,
            leaseUntil: null,
            ...(acknowledged ? { deliveredAt: new Date(now()) } : {}),
          })
          .where(condition);
        if (acknowledged)
          await transaction
            .update(loginSecurity)
            .set({ alertPending: false })
            .where(
              and(
                eq(loginSecurity.userId, job.userId),
                eq(loginSecurity.lockedUntil, job.lockedUntil),
              ),
            );
      }),
    );
    log(
      event(
        acknowledged ? 'delivered' : job.attempts >= 10 ? 'retry-exhausted' : 'retry-scheduled',
        job,
        acknowledged ? undefined : 'SECURITY_ALERT_DELIVERY_UNCONFIRMED',
      ),
    );
    return acknowledged;
  }
  async function batch() {
    if (stopping || !options.AUTH_SECURITY_WORKER_ENABLED) return 0;
    const jobs = await retryTransaction(() =>
      db.get('writer').transaction(async (transaction) => {
        await transaction
          .update(securityAlerts)
          .set({
            state: 'pending',
            leaseToken: null,
            leaseUntil: null,
            availableAt: new Date(now()),
          })
          .where(
            and(
              eq(securityAlerts.state, 'dispatching'),
              lte(securityAlerts.leaseUntil, new Date(now())),
            ),
          )
          .limit(options.AUTH_SECURITY_BATCH_SIZE);
        const rows = await transaction
          .select()
          .from(securityAlerts)
          .where(
            and(
              eq(securityAlerts.state, 'pending'),
              lte(securityAlerts.availableAt, new Date(now())),
            ),
          )
          .orderBy(asc(securityAlerts.availableAt), asc(securityAlerts.id))
          .limit(options.AUTH_SECURITY_BATCH_SIZE)
          .for('update', { skipLocked: true });
        const claimed = rows.map((row) => ({
          ...row,
          attempts: row.attempts + 1,
          leaseToken: crypto.randomUUID(),
          leaseUntil: new Date(now() + 30000),
        }));
        for (const row of claimed)
          await transaction
            .update(securityAlerts)
            .set({
              state: 'dispatching',
              attempts: row.attempts,
              leaseToken: row.leaseToken,
              leaseUntil: row.leaseUntil,
            })
            .where(eq(securityAlerts.id, row.id));
        return claimed;
      }),
    );
    const results = await Promise.all(jobs.map(deliver));
    if (now() - lastCleanup >= 60000) {
      const before = new Date(now() - 86400000);
      await db
        .get('writer')
        .delete(loginChallenges)
        .where(lt(loginChallenges.expiresAt, before))
        .limit(500);
      await pruneExpiredSessions(db, before);
      await pruneOperatorMfaEnrollments(db, new Date(now()));
      await pruneSlackConnections(db, now());
      await pruneApplicationLinks(db, now());
      lastCleanup = now();
    }
    return results.filter(Boolean).length;
  }
  return {
    runOnce() {
      if (active) return active;
      active = batch().finally(() => {
        active = undefined;
      });
      return active;
    },
    stop() {
      if (!stopPromise) {
        stopping = true;
        abort.abort();
        stopPromise = (async () => {
          try {
            await active;
          } finally {
            log(event('stopped'));
          }
        })();
      }
      return stopPromise;
    },
  };
}
export async function retrySecurityAlert(db: Databases, id: string) {
  z.uuid().parse(id);
  return retryTransaction(() =>
    db.get('writer').transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(securityAlerts)
        .where(eq(securityAlerts.id, id))
        .limit(1)
        .for('update');
      if (!row)
        throw new AppError(404, 'SECURITY_ALERT_NOT_FOUND', 'The security alert was not found.');
      if (row.deliveredAt || row.state === 'sent')
        throw new AppError(
          409,
          'SECURITY_ALERT_ALREADY_DELIVERED',
          'This security alert was already delivered.',
        );
      if (row.state === 'dispatching' && row.leaseUntil && row.leaseUntil.getTime() > Date.now())
        throw new AppError(
          409,
          'SECURITY_ALERT_DELIVERY_ACTIVE',
          'The security alert is still being delivered.',
        );
      await transaction
        .update(securityAlerts)
        .set({
          state: 'pending',
          attempts: 0,
          availableAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(securityAlerts.id, id));
      return { alertId: row.id, requestId: row.requestId, userId: row.userId };
    }),
  );
}
