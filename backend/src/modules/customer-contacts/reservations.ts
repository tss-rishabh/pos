import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  customerContactChallenges as challenges,
  customerContactMutexes as mutexes,
  customerContactReservations as reservations,
} from './schema.js';

export const customerContactKey = z.string().regex(/^(?:email|phone):[a-f0-9]{64}$/);
function keys(input: readonly string[]) {
  return [...new Set(z.array(customerContactKey).min(1).max(4).parse(input))].sort();
}
const reserved = () =>
  new AppError(
    409,
    'CUSTOMER_CONTACT_RESERVED',
    'A verified contact change is pending. Finish or cancel it before reusing this contact.',
  );
/** Caller locks its checkout first; retain these sorted mutex locks until the whole transaction commits. */
export async function lockCustomerContactKeys(
  tx: AdministrationTransaction,
  input: readonly string[],
): Promise<void> {
  for (const key of keys(input)) {
    await tx.insert(mutexes).values({ key }).onDuplicateKeyUpdate({ set: { key } });
    const [row] = await tx
      .select({ key: mutexes.key })
      .from(mutexes)
      .where(eq(mutexes.key, key))
      .for('update');
    if (!row)
      throw new AppError(
        503,
        'CUSTOMER_CONTACT_LOCK_UNAVAILABLE',
        'Customer contact reservation is unavailable.',
      );
  }
}
/** Must run under lockCustomerContactKeys. Unknown or quarantined owners always fail closed. */
export async function assertNoActiveContactChangeReservation(
  tx: AdministrationTransaction,
  input: readonly string[],
  nowMs: number,
): Promise<void> {
  z.number().int().nonnegative().refine(Number.isSafeInteger).parse(nowMs);
  for (const key of keys(input)) {
    const [reservation] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.key, key))
      .for('update');
    if (!reservation) continue;
    const [owner] = await tx
      .select()
      .from(challenges)
      .where(eq(challenges.id, reservation.challengeId))
      .for('update');
    if (!owner) throw reserved();
    if (['COMMITTING', 'UNCERTAIN'].includes(owner.status)) throw reserved();
    const pending = ['PENDING_CURRENT', 'PENDING_NEW', 'READY'].includes(owner.status);
    if (pending && (owner.expiresAt > nowMs || reservation.expiresAt > nowMs)) throw reserved();
    if (!pending && !['COMMITTED', 'CANCELLED', 'EXPIRED', 'LOCKED'].includes(owner.status))
      throw reserved();
    if (pending)
      await tx
        .update(challenges)
        .set({ status: 'EXPIRED', activeCustomerId: null, codeHash: '', updatedAt: nowMs })
        .where(eq(challenges.id, owner.id));
    // Other targets of this challenge remain locked/reconciled by their own perpetual key mutex.
    await tx.delete(reservations).where(eq(reservations.key, key));
  }
}
export async function reserveCustomerContactKeys(
  tx: AdministrationTransaction,
  input: readonly string[],
  challengeId: string,
  expiresAt: number,
): Promise<void> {
  z.uuid().parse(challengeId);
  z.number().int().nonnegative().refine(Number.isSafeInteger).parse(expiresAt);
  for (const key of keys(input))
    await tx.insert(reservations).values({ key, challengeId, expiresAt });
}
/** Caller holds every affected key mutex; never release a different operation's reservation. */
export async function releaseCustomerContactKeys(
  tx: AdministrationTransaction,
  input: readonly string[],
  challengeId: string,
): Promise<void> {
  const selected = keys(input);
  z.uuid().parse(challengeId);
  const rows = await tx
    .select()
    .from(reservations)
    .where(inArray(reservations.key, selected))
    .for('update');
  for (const row of rows)
    if (row.challengeId === challengeId)
      await tx.delete(reservations).where(eq(reservations.key, row.key));
}
