import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { checkInService } from '../administration/checkins.js';
import {
  contactActorVersion,
  contactFingerprint,
  contactUnavailable,
  lockContactCustomer,
} from './authority.js';
import { contactChangeContract, type CustomerContactDelivery } from './contracts.js';
import { matchesContactCode, openContactEffects, openContactOtp } from './crypto.js';
import type { CustomerContactOptions } from './options.js';
import { lockCustomerContactKeys, releaseCustomerContactKeys } from './reservations.js';
import {
  customerContactChallenges as challenges,
  customerContactDeliveries as deliveries,
} from './schema.js';

type Delivery = typeof deliveries.$inferSelect;
export interface CustomerContactWorkerEvent {
  module: 'customer-contacts';
  resource: 'customer-contact-delivery';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string;
  deliveryId: string;
  challengeId: string;
  outcome: 'delivered' | 'rejected' | 'uncertain' | 'cancelled' | 'retry';
}
export function customerContactOutbox(
  config: Pick<Config, 'DEMO_MODE' | 'BUSINESS_TIMEZONE'>,
  db: Databases,
  options: CustomerContactOptions,
  sender: CustomerContactDelivery | undefined,
  clock: () => number = Date.now,
  emit: (event: CustomerContactWorkerEvent) => void = () => undefined,
) {
  const checkIns = checkInService(db, config);
  function ready() {
    if (
      config.DEMO_MODE ||
      !options.CUSTOMER_CONTACTS_ENABLED ||
      options.CUSTOMER_CONTACTS_CONTRACT !== contactChangeContract ||
      !options.CUSTOMER_CONTACTS_SECRET ||
      !sender
    )
      throw contactUnavailable();
    return sender;
  }
  async function claim() {
    const now = clock(),
      [candidate] = await db
        .get('writer')
        .select({ id: deliveries.id, challengeId: deliveries.challengeId, kind: deliveries.kind })
        .from(deliveries)
        .where(
          and(
            inArray(deliveries.status, ['PENDING', 'SENDING']),
            or(isNull(deliveries.leaseExpiresAt), lte(deliveries.leaseExpiresAt, now)),
          ),
        )
        .orderBy(asc(deliveries.createdAt), asc(deliveries.id))
        .limit(1);
    if (!candidate) return null;
    const [initial] = await db
      .get('writer')
      .select()
      .from(challenges)
      .where(eq(challenges.id, candidate.challengeId))
      .limit(1);
    if (!initial)
      return db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, candidate.id))
          .for('update');
        if (
          !row ||
          !['PENDING', 'SENDING'].includes(row.status) ||
          (row.leaseExpiresAt !== null && row.leaseExpiresAt > now)
        )
          return null;
        await tx
          .update(deliveries)
          .set({ status: 'UNCERTAIN', leaseToken: null, leaseExpiresAt: null, updatedAt: now })
          .where(eq(deliveries.id, row.id));
        return { row, terminal: 'uncertain' as const };
      });
    return db.get('writer').transaction(async (tx) => {
      let allowed = true;
      if (candidate.kind === 'otp') {
        try {
          await checkIns.assertCheckIn(initial.operatorId, initial.storeId, initial.counterId, tx);
          allowed = (await contactActorVersion(tx, initial.operatorId)) === initial.actorVersion;
        } catch (error) {
          if (error instanceof AppError && [401, 403, 409].includes(error.status)) allowed = false;
          else throw error;
        }
      }
      await lockCustomerContactKeys(tx, [initial.targetKey]);
      if (candidate.kind === 'otp' && allowed) {
        try {
          allowed =
            contactFingerprint(
              options.CUSTOMER_CONTACTS_SECRET!,
              await lockContactCustomer(tx, initial.customerId),
            ) === initial.contactFingerprint;
        } catch (error) {
          if (error instanceof AppError && [401, 403].includes(error.status)) allowed = false;
          else throw error;
        }
      }
      const [challenge] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.id, candidate.challengeId))
          .for('update'),
        [row] = await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, candidate.id))
          .for('update');
      if (
        !row ||
        !challenge ||
        !['PENDING', 'SENDING'].includes(row.status) ||
        (row.leaseExpiresAt !== null && row.leaseExpiresAt > now)
      )
        return null;
      const terminal = async (status: 'CANCELLED' | 'UNCERTAIN') => {
        await tx
          .update(deliveries)
          .set({
            status,
            leaseToken: null,
            leaseExpiresAt: null,
            ...(status === 'CANCELLED' ? { encryptedPayload: '' } : {}),
            updatedAt: now,
          })
          .where(eq(deliveries.id, row.id));
        return {
          row,
          terminal: status === 'CANCELLED' ? ('cancelled' as const) : ('uncertain' as const),
        };
      };
      if (row.kind === 'otp') {
        if (row.status === 'SENDING') return terminal('UNCERTAIN');
        if (
          !allowed ||
          !['PENDING_CURRENT', 'PENDING_NEW'].includes(challenge.status) ||
          challenge.stage !== row.stage ||
          challenge.expiresAt <= now ||
          row.expiresAt <= now ||
          challenge.codeExpiresAt <= now
        )
          return terminal('CANCELLED');
        let valid = false;
        try {
          const input = openContactOtp(
            options.CUSTOMER_CONTACTS_SECRET!,
            row.id,
            row.encryptedPayload,
          );
          valid =
            input.challengeId === challenge.id &&
            input.stage === challenge.stage &&
            matchesContactCode(
              challenge.codeHash,
              options.CUSTOMER_CONTACTS_SECRET!,
              challenge.id,
              input.stage,
              input.code,
            );
        } catch {
          /* Corrupted or superseded OTP is never sent. */
        }
        if (!valid) return terminal('CANCELLED');
      } else {
        if (challenge.status === 'COMMITTED') {
          await tx
            .update(deliveries)
            .set({ status: 'DELIVERED', leaseToken: null, leaseExpiresAt: null, updatedAt: now })
            .where(eq(deliveries.id, row.id));
          return { row, terminal: 'delivered' as const };
        }
        if (!['COMMITTING', 'UNCERTAIN'].includes(challenge.status)) return terminal('UNCERTAIN');
        if (row.attempts >= 5 || !options.CUSTOMER_CONTACT_EFFECTS_REPLAY_SAFE) {
          await tx
            .update(challenges)
            .set({ status: 'UNCERTAIN', updatedAt: now })
            .where(eq(challenges.id, challenge.id));
          return terminal('UNCERTAIN');
        }
      }
      const token = randomUUID(),
        leaseExpiresAt = now + options.CUSTOMER_CONTACTS_WORKER_LEASE_MS;
      await tx
        .update(deliveries)
        .set({
          status: 'SENDING',
          leaseToken: token,
          leaseExpiresAt,
          attempts: row.attempts + 1,
          updatedAt: now,
        })
        .where(eq(deliveries.id, row.id));
      return {
        row: {
          ...row,
          status: 'SENDING' as const,
          leaseToken: token,
          leaseExpiresAt,
          attempts: row.attempts + 1,
        },
        terminal: null,
      };
    });
  }
  async function finish(row: Delivery, outcome: 'accepted' | 'rejected' | 'uncertain') {
    const now = clock();
    return db.get('writer').transaction(async (tx) => {
      const [initial] = await tx
        .select()
        .from(challenges)
        .where(eq(challenges.id, row.challengeId))
        .limit(1);
      if (!initial)
        throw new AppError(
          503,
          'CUSTOMER_CONTACT_DELIVERY_REVIEW',
          'A saved contact delivery needs review.',
        );
      await lockCustomerContactKeys(tx, [initial.targetKey]);
      const [challenge] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.id, row.challengeId))
          .for('update'),
        [current] = await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, row.id))
          .for('update');
      if (
        !current ||
        !challenge ||
        current.status !== 'SENDING' ||
        current.leaseToken !== row.leaseToken
      )
        return 'uncertain' as const;
      const retry =
        row.kind === 'source-effects' &&
        outcome === 'uncertain' &&
        row.attempts < 5 &&
        options.CUSTOMER_CONTACT_EFFECTS_REPLAY_SAFE;
      const status =
        outcome === 'accepted'
          ? ('DELIVERED' as const)
          : retry
            ? ('PENDING' as const)
            : outcome === 'rejected'
              ? ('REJECTED' as const)
              : ('UNCERTAIN' as const);
      await tx
        .update(deliveries)
        .set({
          status,
          leaseToken: null,
          leaseExpiresAt: retry ? now + Math.min(60000, 2000 * 2 ** row.attempts) : null,
          updatedAt: now,
        })
        .where(eq(deliveries.id, row.id));
      if (row.kind === 'source-effects') {
        if (outcome === 'accepted') {
          await tx
            .update(challenges)
            .set({
              status: 'COMMITTED',
              activeCustomerId: null,
              version: challenge.version + 1,
              updatedAt: now,
            })
            .where(eq(challenges.id, challenge.id));
          await releaseCustomerContactKeys(tx, [challenge.targetKey], challenge.id);
        } else if (!retry)
          await tx
            .update(challenges)
            .set({ status: 'UNCERTAIN', version: challenge.version + 1, updatedAt: now })
            .where(eq(challenges.id, challenge.id));
      }
      return retry
        ? ('retry' as const)
        : outcome === 'accepted'
          ? ('delivered' as const)
          : outcome === 'rejected'
            ? ('rejected' as const)
            : ('uncertain' as const);
    });
  }
  return {
    async drain(signal: AbortSignal, limit = 10) {
      const adapter = ready(),
        count = z.number().int().min(1).max(100).parse(limit),
        summary = { delivered: 0, rejected: 0, uncertain: 0, cancelled: 0, retry: 0 };
      for (let index = 0; index < count && !signal.aborted; index++) {
        const claimed = await claim();
        if (!claimed) break;
        let outcome: CustomerContactWorkerEvent['outcome'] | null = claimed.terminal;
        if (!outcome) {
          let result: 'accepted' | 'rejected' | 'uncertain' = 'uncertain';
          try {
            result =
              claimed.row.kind === 'otp'
                ? await adapter.sendOtp(
                    claimed.row.id,
                    openContactOtp(
                      options.CUSTOMER_CONTACTS_SECRET!,
                      claimed.row.id,
                      claimed.row.encryptedPayload,
                    ),
                    signal,
                  )
                : await adapter.sourceEffects(
                    claimed.row.id,
                    openContactEffects(
                      options.CUSTOMER_CONTACTS_SECRET!,
                      claimed.row.id,
                      claimed.row.encryptedPayload,
                    ),
                    signal,
                  );
          } catch {
            /* Network, shutdown and decoder failures never expose payloads or raw errors. */
          }
          outcome = await finish(claimed.row, result);
        }
        summary[outcome]++;
        emit({
          module: 'customer-contacts',
          resource: 'customer-contact-delivery',
          eventId: 'customer-contacts.customer-contact-delivery.' + outcome,
          eventInstanceId: randomUUID(),
          requestId: claimed.row.requestId,
          userId: claimed.row.operatorId,
          deliveryId: claimed.row.id,
          challengeId: claimed.row.challengeId,
          outcome,
        });
      }
      return summary;
    },
  };
}
