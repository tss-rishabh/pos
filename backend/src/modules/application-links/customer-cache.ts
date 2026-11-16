import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import type { CustomerApplicationProvider } from './provider.js';
import { customerApplicationCache as cache } from './schema.js';

export function customerApplicationCacheService(
  db: Databases,
  provider: CustomerApplicationProvider,
  now: () => number,
) {
  return async (storeId: string) => {
    const leaseId = randomUUID(),
      claim = await db.get('writer').transaction(async (tx) => {
        await tx
          .insert(cache)
          .values({
            storeId: BigInt(storeId),
            providerOperationId: randomUUID(),
            configurationVersion: provider.configurationVersion,
            expiresAt: 0n,
          })
          .onDuplicateKeyUpdate({ set: { storeId: BigInt(storeId) } });
        const [row] = await tx
          .select()
          .from(cache)
          .where(eq(cache.storeId, BigInt(storeId)))
          .limit(1)
          .for('update');
        if (!row)
          throw new AppError(
            503,
            'CUSTOMER_APPLICATION_UNAVAILABLE',
            'The customer application link is temporarily unavailable.',
          );
        const timestamp = BigInt(now());
        if (
          row.configurationVersion === provider.configurationVersion &&
          row.target &&
          row.expiresAt > timestamp &&
          provider.accepts(row.target)
        )
          return { target: row.target };
        if (row.leaseId && row.leaseUntil && row.leaseUntil > timestamp)
          throw new AppError(
            409,
            'CUSTOMER_APPLICATION_PREPARING',
            'The customer application link is being prepared. Try again shortly.',
          );
        const providerOperationId =
          row.configurationVersion === provider.configurationVersion && row.target === null
            ? row.providerOperationId
            : randomUUID();
        await tx
          .update(cache)
          .set({
            configurationVersion: provider.configurationVersion,
            providerOperationId,
            target: null,
            expiresAt: 0n,
            leaseId,
            leaseUntil: timestamp + 30000n,
          })
          .where(eq(cache.storeId, BigInt(storeId)));
        return { providerOperationId };
      });
    if ('target' in claim) return claim.target!;
    try {
      const target = await provider.destination(storeId, claim.providerOperationId);
      if (!provider.accepts(target))
        throw new AppError(
          503,
          'CUSTOMER_APPLICATION_UNAVAILABLE',
          'The customer application link is temporarily unavailable.',
        );
      await db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cache)
          .where(eq(cache.storeId, BigInt(storeId)))
          .limit(1)
          .for('update');
        if (
          row?.leaseId !== leaseId ||
          row.configurationVersion !== provider.configurationVersion ||
          row.providerOperationId !== claim.providerOperationId
        )
          throw new AppError(
            409,
            'CUSTOMER_APPLICATION_CHANGED',
            'The customer application link changed. Try again.',
          );
        await tx
          .update(cache)
          .set({ target, expiresAt: BigInt(now()) + 3600000n, leaseId: null, leaseUntil: null })
          .where(eq(cache.storeId, BigInt(storeId)));
      });
      return target;
    } catch (error) {
      await db
        .get('writer')
        .update(cache)
        .set({ leaseId: null, leaseUntil: null })
        .where(and(eq(cache.storeId, BigInt(storeId)), eq(cache.leaseId, leaseId)));
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'CUSTOMER_APPLICATION_UNAVAILABLE',
        'The customer application link is temporarily unavailable.',
      );
    }
  };
}
