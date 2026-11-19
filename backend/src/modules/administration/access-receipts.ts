import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { currentRequestTrace } from '../../observability/context.js';

/** Ledger `pos_rewrite_administration_access_mutations` -> Redis, EX 86400. */
export const ADMIN_ACCESS_RECEIPT_SECONDS = 86_400;
export const adminAccessReceiptKey = (operationId: string) =>
  `pos:idem:admin_access:${operationId}`;
const stored = z
  .object({
    actorId: z.string(),
    resourceId: z.string(),
    action: z.string(),
    hash: z.string(),
    requestId: z.string().nullable(),
    result: z.unknown(),
  })
  .strict();

/**
 * Replay receipts for operator administration and model-account creation. Legacy Django admin has
 * no replay protection; this only answers a retried request with its original result. Callers
 * hold the `operators` administration lock, check `replay` before the writer transaction and
 * `save` only after it commits, so a receipt never describes an uncommitted change.
 */
export function administrationAccessReceipts(config: Config, ephemeral: EphemeralStore) {
  async function load(id: string) {
    const raw = await ephemeral.get(adminAccessReceiptKey(id));
    if (raw === null) return null;
    try {
      const parsed = stored.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    throw new AppError(
      409,
      'ADMIN_ACCESS_OPERATION_REUSED',
      'Choose a new administration operation.',
    );
  }
  return {
    inputHash: (value: unknown) =>
      createHmac('sha256', config.SESSION_SECRET).update(JSON.stringify(value)).digest('hex'),
    async replay(user: Principal, id: string, resourceId: string, action: string, hash: string) {
      const previous = await load(id);
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
    async save(
      user: Principal,
      id: string,
      resourceId: string,
      action: string,
      hash: string,
      result: unknown,
    ) {
      await ephemeral.set(
        adminAccessReceiptKey(id),
        JSON.stringify({
          actorId: user.id,
          resourceId,
          action,
          hash,
          requestId: currentRequestTrace()?.requestId || null,
          result,
        }),
        { EX: ADMIN_ACCESS_RECEIPT_SECONDS },
      );
      return result;
    },
    /** The original receipt, for the lost-response read route. */
    read: load,
  };
}
