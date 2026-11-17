import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { wholeOrderStatusCommands } from './schema.js';
import { statusState, receiptSchema, requiredStages } from './domain.js';
import { statusAttempts, statusVendorCalls } from './receiver-schema.js';
export type AssertHandoverAvailable = (
  tx: AdministrationTransaction,
  orderIds: readonly string[],
) => Promise<void>;
export function requireHandoverBarrier(
  barrier: AssertHandoverAvailable | undefined,
): AssertHandoverAvailable {
  if (!barrier)
    throw new AppError(
      503,
      'WHOLE_ORDER_HANDOVER_FENCE_REQUIRED',
      'The current cash-return and import handover protections are not configured.',
    );
  return barrier;
}
/** Caller holds the same Store→Order mutation locks as command acceptance. */
export async function assertNoActiveWholeOrderHandover(
  tx: AdministrationTransaction,
  input: readonly string[],
) {
  const ids = z
    .array(identifier)
    .min(1)
    .max(1000)
    .refine((value) => new Set(value).size === value.length)
    .parse(input);
  const commands = await tx
    .select({
      id: wholeOrderStatusCommands.id,
      state: wholeOrderStatusCommands.state,
      platform: wholeOrderStatusCommands.platform,
      scopeHash: wholeOrderStatusCommands.scopeHash,
      requestHash: wholeOrderStatusCommands.requestHash,
      receipt: wholeOrderStatusCommands.receipt,
      attempts: wholeOrderStatusCommands.attempts,
      errorCode: wholeOrderStatusCommands.errorCode,
    })
    .from(wholeOrderStatusCommands)
    .where(inArray(wholeOrderStatusCommands.orderId, ids))
    .limit(1001)
    .for('share');
  const stages = await tx
    .select({ id: statusAttempts.id, state: statusAttempts.state })
    .from(statusAttempts)
    .innerJoin(
      wholeOrderStatusCommands,
      eq(wholeOrderStatusCommands.id, statusAttempts.operationId),
    )
    .where(inArray(wholeOrderStatusCommands.orderId, ids))
    .limit(1001)
    .for('share');
  const calls = await tx
    .select({ id: statusVendorCalls.id, state: statusVendorCalls.state })
    .from(statusVendorCalls)
    .innerJoin(statusAttempts, eq(statusAttempts.id, statusVendorCalls.stageId))
    .innerJoin(
      wholeOrderStatusCommands,
      eq(wholeOrderStatusCommands.id, statusAttempts.operationId),
    )
    .where(inArray(wholeOrderStatusCommands.orderId, ids))
    .limit(1001)
    .for('share');
  const invalid =
    commands.length > 1000 ||
    stages.length > 1000 ||
    calls.length > 1000 ||
    commands.some((row) => !statusState.safeParse(row.state).success) ||
    stages.some(
      (row) =>
        !['QUEUED', 'SENDING', 'SUCCESS', 'FAILED', 'UNEXPECTED', 'UNKNOWN'].includes(row.state),
    ) ||
    calls.some((row) => !['SENDING', 'SUCCESS', 'REJECTED', 'UNKNOWN'].includes(row.state));
  if (invalid)
    throw new AppError(
      409,
      'WHOLE_ORDER_HANDOVER_RECONCILIATION_REQUIRED',
      'The retained fulfillment effects need reconciliation before a cash return.',
    );
  if (
    commands.some((row) => ['PENDING', 'SENDING', 'QUEUED', 'UNCERTAIN'].includes(row.state)) ||
    stages.some((row) => ['QUEUED', 'SENDING', 'UNKNOWN'].includes(row.state)) ||
    calls.some((row) => ['SENDING', 'UNKNOWN'].includes(row.state))
  )
    throw new AppError(
      409,
      'WHOLE_ORDER_HANDOVER_ACTIVE',
      'A fulfillment handover is active or uncertain. Reconcile it before preparing a cash return.',
    );
  const terminalInvalid = commands.some((row) => {
    if (row.state === 'BLOCKED')
      return row.errorCode !== 'STATUS_NOT_SENT' || row.receipt !== null || row.attempts > 1;
    const parsed = receiptSchema.safeParse(row.receipt);
    if (!parsed.success) return true;
    const proof = parsed.data;
    if (
      proof.operationId !== row.id ||
      proof.scopeHash !== row.scopeHash ||
      proof.requestHash !== row.requestHash ||
      !proof.acceptedAt ||
      !proof.completedAt
    )
      return true;
    return row.state === 'SUCCEEDED'
      ? proof.state !== 'succeeded' ||
          requiredStages(row.platform).some(
            (stage) =>
              !proof.stages.some((value) => value.platform === stage && value.status === 'SUCCESS'),
          )
      : row.state === 'REJECTED'
        ? proof.state !== 'rejected' ||
          !proof.stages.some((value) => ['FAILED', 'UNEXPECTED'].includes(value.status))
        : true;
  });
  if (terminalInvalid)
    throw new AppError(
      409,
      'WHOLE_ORDER_HANDOVER_RECONCILIATION_REQUIRED',
      'A terminal fulfillment flag is missing its exact-scope receipt. Reconcile it before a cash return.',
    );
}
