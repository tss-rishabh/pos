import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import {
  assertCustomerOtpEnabled,
  assertCurrentOtpBinding,
  customerOtpAuthority,
  customerOtpDestinations,
} from './authority.js';
import {
  customerOtpScopeSchema,
  type CustomerOtpDelivery,
  type CustomerOtpPayload,
} from './contracts.js';
import { openCustomerOtp, sameCustomerOtpCode } from './crypto.js';
import type { CustomerOtpOptions } from './options.js';
import {
  customerOtpChallenges as challenges,
  customerOtpDeliveries as deliveries,
} from './schema.js';

export interface CustomerOtpWorkerEvent {
  module: 'customer-otp';
  resource: 'customer-otp-delivery';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  challengeId: string;
  deliveryId: string;
}
export function customerOtpOutbox(
  config: Config,
  db: Databases,
  options: CustomerOtpOptions,
  sender: CustomerOtpDelivery | undefined,
  clock: () => number = Date.now,
  onEvent?: (event: CustomerOtpWorkerEvent) => void,
) {
  const lockAuthority = customerOtpAuthority(config, db);
  function emit(
    state: string,
    id: string,
    challengeId: string,
    context: { requestId: string | null; operatorId: string | null },
  ) {
    onEvent?.({
      module: 'customer-otp',
      resource: 'customer-otp-delivery',
      eventId: 'customer-otp.customer-otp-delivery.' + state,
      eventInstanceId: randomUUID(),
      requestId: context.requestId,
      userId: context.operatorId,
      challengeId,
      deliveryId: id,
    });
  }
  async function candidate() {
    const database = db.get('writer'),
      now = clock();
    const [[expired], [pending]] = await Promise.all([
      database
        .select({ id: deliveries.id, challengeId: deliveries.challengeId })
        .from(deliveries)
        .where(and(eq(deliveries.state, 'SENDING'), lte(deliveries.leaseExpiresAt, now)))
        .orderBy(asc(deliveries.leaseExpiresAt), asc(deliveries.id))
        .limit(1),
      database
        .select({ id: deliveries.id, challengeId: deliveries.challengeId })
        .from(deliveries)
        .where(and(eq(deliveries.state, 'PENDING'), lte(deliveries.availableAt, now)))
        .orderBy(asc(deliveries.availableAt), asc(deliveries.id))
        .limit(1),
    ]);
    return expired ?? pending;
  }
  async function claim(id: string, challengeId: string) {
    const now = clock();
    const [metadata] = await db
      .get('writer')
      .select({ scope: challenges.scope })
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);
    return db.get('writer').transaction(async (tx) => {
      // A crashed/unknown send is never reissued, even if its former scope expired.
      const [preflight] = await tx
        .select({ state: deliveries.state, leaseExpiresAt: deliveries.leaseExpiresAt })
        .from(deliveries)
        .where(eq(deliveries.id, id))
        .limit(1);
      if (preflight?.state === 'SENDING' && (preflight.leaseExpiresAt ?? 0) <= now) {
        const [row] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.id, challengeId))
          .limit(1)
          .for('update');
        const [job] = await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, id))
          .limit(1)
          .for('update');
        if (!job || job.state !== 'SENDING' || (job.leaseExpiresAt ?? 0) > now)
          return { state: 'skipped' as const };
        await tx
          .update(deliveries)
          .set({
            state: 'UNCERTAIN',
            encryptedPayload: '',
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(deliveries.id, id));
        return {
          state: 'uncertain' as const,
          requestId: row?.requestId ?? null,
          operatorId: row?.operatorId ?? null,
        };
      }
      let authorized = false;
      const parsedScope = customerOtpScopeSchema.safeParse(metadata?.scope);
      let current: Awaited<ReturnType<typeof lockAuthority>> | undefined;
      if (parsedScope.success) {
        try {
          current = await lockAuthority(tx, parsedScope.data, challengeId);
          authorized = true;
        } catch (error) {
          if (
            !(error instanceof AppError && [401, 403, 404, 409].includes(error.status)) &&
            !(error instanceof z.ZodError)
          )
            throw error;
        }
      }
      const [row] = await tx
        .select()
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .limit(1)
        .for('update');
      const [job] = await tx
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, id))
        .limit(1)
        .for('update');
      if (!job || job.state !== 'PENDING' || job.availableAt > now)
        return { state: 'skipped' as const };
      if (authorized && row && current) {
        try {
          assertCurrentOtpBinding(row, current);
        } catch {
          authorized = false;
        }
      }
      if (!authorized || !row || row.state !== 'ACTIVE' || row.expiresAt <= now || !current) {
        await tx
          .update(deliveries)
          .set({ state: 'CANCELLED', encryptedPayload: '', updatedAt: now })
          .where(eq(deliveries.id, id));
        if (row?.state === 'ACTIVE' && (!authorized || row.expiresAt <= now))
          await tx
            .update(challenges)
            .set({
              state: row.expiresAt <= now ? 'EXPIRED' : 'CANCELLED',
              codeHash: '',
              activeScopeHash: null,
              verifiedUntil: null,
              updatedAt: now,
            })
            .where(eq(challenges.id, challengeId));
        return {
          state: 'cancelled' as const,
          requestId: row?.requestId ?? null,
          operatorId: row?.operatorId ?? null,
        };
      }
      let payload: CustomerOtpPayload;
      try {
        payload = openCustomerOtp(options.CUSTOMER_OTP_SECRET!, id, job.encryptedPayload);
        if (
          payload.channel !== job.channel ||
          payload.purpose !== row.scope.purpose ||
          !sameCustomerOtpCode(row.codeHash, options.CUSTOMER_OTP_SECRET!, row.id, payload.code) ||
          !customerOtpDestinations(current, options).some(
            (destination) =>
              destination.channel === payload.channel &&
              destination.destination === payload.destination,
          )
        )
          throw new Error('Customer OTP delivery binding invalid');
        sender!.assertReady(payload.purpose, payload.channel);
      } catch {
        await tx
          .update(deliveries)
          .set({ state: 'REJECTED', encryptedPayload: '', updatedAt: now })
          .where(eq(deliveries.id, id));
        return { state: 'rejected' as const, requestId: row.requestId, operatorId: row.operatorId };
      }
      const token = randomUUID();
      await tx
        .update(deliveries)
        .set({
          state: 'SENDING',
          leaseToken: token,
          leaseExpiresAt: now + options.CUSTOMER_OTP_LEASE_MS,
          updatedAt: now,
        })
        .where(eq(deliveries.id, id));
      return {
        state: 'send' as const,
        id,
        token,
        challengeId,
        payload,
        requestId: row.requestId,
        operatorId: row.operatorId,
      };
    });
  }
  return {
    async drain(signal: AbortSignal, limit = 10) {
      const result = { delivered: 0, uncertain: 0, rejected: 0, cancelled: 0, skipped: 0 };
      if (!options.CUSTOMER_OTP_WORKER_ENABLED) return result;
      assertCustomerOtpEnabled(config, options);
      if (!sender) return result;
      const bounded = z.number().int().min(1).max(100).parse(limit);
      for (let count = 0; count < bounded && !signal.aborted; count++) {
        const next = await candidate();
        if (!next) break;
        const job = await claim(next.id, next.challengeId);
        if (job.state !== 'send') {
          result[job.state]++;
          if (job.state !== 'skipped') emit(job.state, next.id, next.challengeId, job);
          continue;
        }
        let status: 'accepted' | 'rejected' | 'uncertain' = 'uncertain';
        try {
          status = await sender.send(job.id, job.payload, signal);
        } catch {
          /* Unknown sends remain frozen. */
        }
        const recorded = await db.get('writer').transaction(async (tx) => {
          await tx
            .select({ id: challenges.id })
            .from(challenges)
            .where(eq(challenges.id, job.challengeId))
            .limit(1)
            .for('update');
          const [stored] = await tx
            .select()
            .from(deliveries)
            .where(eq(deliveries.id, job.id))
            .limit(1)
            .for('update');
          if (!stored || stored.state !== 'SENDING' || stored.leaseToken !== job.token)
            return false;
          await tx
            .update(deliveries)
            .set({
              state:
                status === 'accepted'
                  ? 'ACCEPTED'
                  : status === 'rejected'
                    ? 'REJECTED'
                    : 'UNCERTAIN',
              encryptedPayload: '',
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: clock(),
            })
            .where(eq(deliveries.id, job.id));
          return true;
        });
        const durableStatus = recorded ? status : 'uncertain';
        result[durableStatus === 'accepted' ? 'delivered' : durableStatus]++;
        emit(durableStatus, job.id, job.challengeId, job);
      }
      return result;
    },
  };
}
