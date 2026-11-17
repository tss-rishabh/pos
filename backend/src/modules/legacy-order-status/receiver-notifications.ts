import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import { statusDigest } from './domain.js';
import { statusNotificationAttempts } from './receiver-schema.js';
import type { StatusCommand } from './transport.js';
import type { statusReceiverHttp } from './receiver-http.js';
export function statusNotifications(
  db: Databases,
  clock: () => number,
  post: ReturnType<typeof statusReceiverHttp>,
  event: (row: StatusCommand, state: string) => void,
) {
  const writer = () => db.get('writer');
  return async function notification(
    row: StatusCommand,
    kind: 'activity' | 'contact',
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ) {
    const id = statusDigest(['store-netcore', row.scopeHash, kind]),
      claimToken = randomUUID();
    const acquired = await retryTransaction(() =>
      writer().transaction(async (tx) => {
        await tx
          .insert(statusNotificationAttempts)
          .values({
            id,
            claimToken,
            operationId: row.id,
            kind,
            state: 'SENDING',
            updatedAt: clock(),
          })
          .onDuplicateKeyUpdate({ set: { id: sql`${statusNotificationAttempts.id}` } });
        const [owned] = await tx
          .select()
          .from(statusNotificationAttempts)
          .where(eq(statusNotificationAttempts.id, id))
          .limit(1)
          .for('update');
        return { acquired: owned?.claimToken === claimToken, state: owned?.state };
      }),
    );
    if (!acquired.acquired) {
      if (acquired.state !== 'SUCCESS')
        throw new AppError(
          502,
          'STORE_NETCORE_UNKNOWN',
          'The notification outcome needs reconciliation.',
        );
      return;
    }
    try {
      await post(url, body, headers, false);
      await writer()
        .update(statusNotificationAttempts)
        .set({ state: 'SUCCESS', updatedAt: clock() })
        .where(eq(statusNotificationAttempts.id, id));
    } catch {
      await writer()
        .update(statusNotificationAttempts)
        .set({ state: 'UNKNOWN', updatedAt: clock() })
        .where(eq(statusNotificationAttempts.id, id));
      event(row, 'NETCORE_OUTCOME_UNKNOWN');
      throw new AppError(502, 'STORE_NETCORE_UNKNOWN', 'The notification outcome is unknown.');
    }
  };
}
