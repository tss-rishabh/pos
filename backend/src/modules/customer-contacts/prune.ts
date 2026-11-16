import { and, asc, eq, inArray, lt, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import {
  customerContactChallenges as challenges,
  customerContactDeliveries as deliveries,
} from './schema.js';
import { lockCustomerContactKeys, releaseCustomerContactKeys } from './reservations.js';

/** Bounded expiry never cancels a committed/uncertain customer update or deletes its identity/audit. */
export async function pruneCustomerContactProofs(db: Databases, now = Date.now(), limit = 100) {
  z.number().int().nonnegative().refine(Number.isSafeInteger).parse(now);
  z.number().int().min(1).max(1000).parse(limit);
  const expired = await db
    .get('writer')
    .select({ id: challenges.id, key: challenges.targetKey })
    .from(challenges)
    .where(
      and(
        inArray(challenges.status, ['PENDING_CURRENT', 'PENDING_NEW', 'READY']),
        lte(challenges.expiresAt, now),
      ),
    )
    .orderBy(asc(challenges.expiresAt), asc(challenges.id))
    .limit(limit);
  let proofs = 0;
  for (const item of expired)
    await db.get('writer').transaction(async (tx) => {
      await lockCustomerContactKeys(tx, [item.key]);
      const [row] = await tx
        .select()
        .from(challenges)
        .where(eq(challenges.id, item.id))
        .for('update');
      if (
        !row ||
        !['PENDING_CURRENT', 'PENDING_NEW', 'READY'].includes(row.status) ||
        row.expiresAt > now
      )
        return;
      await tx
        .update(challenges)
        .set({
          status: 'EXPIRED',
          activeCustomerId: null,
          codeHash: '',
          version: row.version + 1,
          updatedAt: now,
        })
        .where(eq(challenges.id, row.id));
      await tx
        .update(deliveries)
        .set({ status: 'CANCELLED', encryptedPayload: '', updatedAt: now })
        .where(
          and(
            eq(deliveries.challengeId, row.id),
            eq(deliveries.kind, 'otp'),
            eq(deliveries.status, 'PENDING'),
          ),
        );
      await releaseCustomerContactKeys(tx, [row.targetKey], row.id);
      proofs++;
    });
  const oldCodes = await db
    .get('writer')
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.kind, 'otp'),
        lte(deliveries.expiresAt, now),
        ne(deliveries.encryptedPayload, ''),
        inArray(deliveries.status, ['DELIVERED', 'UNCERTAIN', 'REJECTED', 'CANCELLED']),
      ),
    )
    .orderBy(asc(deliveries.expiresAt), asc(deliveries.id))
    .limit(limit);
  if (oldCodes.length)
    await db
      .get('writer')
      .update(deliveries)
      .set({ encryptedPayload: '', updatedAt: now })
      .where(
        and(
          inArray(
            deliveries.id,
            oldCodes.map((row) => row.id),
          ),
          lt(deliveries.expiresAt, now + 1),
          ne(deliveries.status, 'SENDING'),
        ),
      );
  return { expiredProofs: proofs, clearedCodes: oldCodes.length };
}
