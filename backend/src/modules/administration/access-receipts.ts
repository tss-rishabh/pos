import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from './checkins.js';
import { administrationAccessMutations } from './access-schema.js';

export function administrationAccessReceipts(config: Config) {
  return {
    inputHash: (value: unknown) =>
      createHmac('sha256', config.SESSION_SECRET).update(JSON.stringify(value)).digest('hex'),
    async replay(
      tx: AdministrationTransaction,
      user: Principal,
      id: string,
      resourceId: string,
      action: string,
      hash: string,
      mode: 'share' | 'update' = 'update',
    ) {
      const [previous] = await tx
        .select()
        .from(administrationAccessMutations)
        .where(eq(administrationAccessMutations.id, id))
        .limit(1)
        .for(mode);
      if (!previous) return null;
      if (
        previous.actorId !== user.id ||
        previous.resourceId !== resourceId ||
        previous.action !== action ||
        previous.hash !== hash
      )
        throw new AppError(
          409,
          'ADMIN_ACCESS_OPERATION_REUSED',
          'Choose a new administration operation.',
        );
      return previous.result;
    },
    async receipt(
      tx: AdministrationTransaction,
      user: Principal,
      id: string,
      resourceId: string,
      action: string,
      hash: string,
      result: (typeof administrationAccessMutations.$inferSelect)['result'],
    ) {
      await tx.insert(administrationAccessMutations).values({
        id,
        actorId: user.id,
        resourceId,
        action,
        hash,
        requestId: currentRequestTrace()?.requestId || null,
        result,
        createdAt: new Date(),
      });
      return result;
    },
  };
}
