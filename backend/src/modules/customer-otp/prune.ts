import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import {
  customerOtpChallenges as challenges,
  customerOtpDeliveries as deliveries,
} from './schema.js';

/** Keep receipts and budgets; only pending secrets expire. No financial identity is deleted. */
export async function pruneCustomerOtpProofs(db: Databases, now = Date.now()) {
  return db.get('writer').transaction(async (tx) => {
    const rows = await tx
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.state, 'ACTIVE'), lte(challenges.expiresAt, now)))
      .orderBy(asc(challenges.expiresAt), asc(challenges.id))
      .limit(200)
      .for('update', { skipLocked: true });
    if (!rows.length) return { expired: 0 };
    const ids = rows.map((row) => row.id);
    await tx
      .update(challenges)
      .set({
        state: 'EXPIRED',
        codeHash: '',
        activeScopeHash: null,
        verifiedUntil: null,
        updatedAt: now,
      })
      .where(inArray(challenges.id, ids));
    await tx
      .update(deliveries)
      .set({ state: 'CANCELLED', encryptedPayload: '', updatedAt: now })
      .where(and(inArray(deliveries.challengeId, ids), eq(deliveries.state, 'PENDING')));
    return { expired: rows.length };
  });
}
