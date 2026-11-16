import { eq } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { legacyReceiptSchema } from '../domain.js';
import { legacyCommands, legacyRtoReceipts } from '../schema.js';
import { cancellationMovement, lifecycleReceipt, type CancellationMovement } from './contracts.js';
import { hash, reconciliation } from './domain.js';

/** One order-scoped physical inward authority for both cancellation and RTO. */
export async function verifyOrderMovement(
  tx: AdministrationTransaction,
  row: typeof legacyRtoReceipts.$inferSelect,
  orderId: string,
  storeId: string,
) {
  if (String(row.orderId) !== orderId || String(row.storeId) !== storeId) throw reconciliation();
  const [command] = await tx
    .select()
    .from(legacyCommands)
    .where(eq(legacyCommands.id, row.commandId))
    .limit(1)
    .for('share');
  if (!command || command.storeId !== storeId || command.orderId !== orderId || !command.result)
    throw reconciliation();
  const rto = legacyReceiptSchema.safeParse(row.receipt);
  if (rto.success) {
    const proof = legacyReceiptSchema.safeParse(command.result);
    if (
      !proof.success ||
      command.action !== 'rto-receipt' ||
      rto.data.commandId !== row.commandId ||
      rto.data.orderId !== orderId ||
      rto.data.storeId !== storeId ||
      rto.data.action !== 'rto-receipt' ||
      hash(proof.data) !== hash(rto.data)
    )
      throw reconciliation();
    return { kind: 'rto' as const, receipt: rto.data };
  }
  const cancellation = cancellationMovement.safeParse(row.receipt),
    proof = lifecycleReceipt.safeParse(command.result);
  if (
    !cancellation.success ||
    !proof.success ||
    cancellation.data.commandId !== row.commandId ||
    cancellation.data.orderId !== orderId ||
    cancellation.data.storeId !== storeId ||
    proof.data.commandId !== row.commandId ||
    proof.data.phase !== 'completed' ||
    proof.data.inventoryMovementCommandId !== row.commandId ||
    !['cancelled', 'converted'].includes(proof.data.outcome)
  )
    throw reconciliation();
  return { kind: 'cancellation' as const, receipt: cancellation.data };
}
export async function readOrderMovement(
  tx: AdministrationTransaction,
  orderId: string,
  storeId: string,
) {
  const [row] = await tx
    .select()
    .from(legacyRtoReceipts)
    .where(eq(legacyRtoReceipts.orderId, BigInt(orderId)))
    .limit(1)
    .for('update');
  return row ? verifyOrderMovement(tx, row, orderId, storeId) : null;
}
export async function recordCancellationMovement(
  tx: AdministrationTransaction,
  supplied: CancellationMovement,
) {
  const receipt = cancellationMovement.parse(supplied);
  await tx.insert(legacyRtoReceipts).values({
    orderId: BigInt(receipt.orderId),
    storeId: BigInt(receipt.storeId),
    commandId: receipt.commandId,
    receipt,
    createdAt: receipt.createdAt,
  });
}
