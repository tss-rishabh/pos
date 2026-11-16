import { Temporal } from '@js-temporal/polyfill';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from './checkins.js';
import { administrationOutbox, type InventoryIntegrationEvent } from './schema.js';

const synchronizationInput = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,36}$/),
    storeId: identifier,
    productIds: z.array(identifier).min(1).max(1000),
    operatorId: identifier,
    reason: z.enum([
      'return',
      'exchange-return',
      'inventory-import',
      'offline-cash-import',
      'legacy-rto',
      'legacy-delivery',
      'order-cancel',
    ]),
    requestId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type InventorySynchronizationInput = z.infer<typeof synchronizationInput>;
const systemSynchronizationInput = synchronizationInput
  .omit({ operatorId: true })
  .extend({ reason: z.enum(['legacy-rto', 'legacy-delivery']) })
  .strict();
export type SystemInventorySynchronizationInput = z.infer<typeof systemSynchronizationInput>;

/** Caller authorizes and mutates stock in this same transaction; retries share the event ID. */
export async function enqueueInventorySynchronization(
  transaction: AdministrationTransaction,
  event: InventorySynchronizationInput,
): Promise<void> {
  const input = synchronizationInput.parse(event);
  return enqueueValidatedInventorySynchronization(transaction, input);
}
/** Trusted durable service-job callers only; preserve source system actor0 without granting HTTP impersonation. */
export async function enqueueSystemInventorySynchronization(
  transaction: AdministrationTransaction,
  event: SystemInventorySynchronizationInput,
): Promise<void> {
  const input = systemSynchronizationInput.parse(event);
  return enqueueValidatedInventorySynchronization(transaction, { ...input, operatorId: '0' });
}
async function enqueueValidatedInventorySynchronization(
  transaction: AdministrationTransaction,
  input: InventorySynchronizationInput,
): Promise<void> {
  const requestId = input.requestId || currentRequestTrace()?.requestId;
  const payload: InventoryIntegrationEvent = {
    kind: 'product.inventory.synchronization',
    storeId: input.storeId,
    productIds: [...new Set(input.productIds)].sort((left, right) =>
      BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
    ),
    actorId: input.operatorId,
    reason: input.reason,
    ...(requestId ? { requestId } : {}),
  };
  await transaction
    .insert(administrationOutbox)
    .values({
      id: input.id,
      kind: payload.kind,
      payload,
      attempts: 0,
      createdAt: Temporal.Now.instant()
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime()
        .toString({ smallestUnit: 'millisecond' })
        .replace('T', ' '),
      deliveredAt: null,
    })
    .onDuplicateKeyUpdate({ set: { id: input.id } });
  const [stored] = await transaction
    .select({ payload: administrationOutbox.payload })
    .from(administrationOutbox)
    .where(eq(administrationOutbox.id, input.id))
    .limit(1)
    .for('update');
  // Never overwrite another operation merely because a caller reused its event ID.
  if (
    !stored ||
    stored.payload.kind !== payload.kind ||
    stored.payload.storeId !== payload.storeId ||
    stored.payload.actorId !== payload.actorId ||
    stored.payload.reason !== payload.reason ||
    JSON.stringify(stored.payload.productIds) !== JSON.stringify(payload.productIds)
  )
    throw new AppError(
      409,
      'INVENTORY_SYNCHRONIZATION_CONFLICT',
      'Inventory synchronization event belongs to another operation.',
    );
}
