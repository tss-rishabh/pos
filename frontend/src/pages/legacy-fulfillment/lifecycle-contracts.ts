import { z } from 'zod';
import { legacyId } from './contracts';
export const deliveryAction = z.enum(['create', 'pass', 'convert', 'cancel']);
export type DeliveryAction = z.infer<typeof deliveryAction>;
export const deliveryReceipt = z
  .object({
    commandId: z.uuid(),
    actorId: z.union([legacyId, z.literal('service')]),
    storeId: legacyId,
    orderId: legacyId,
    action: z.enum(['create', 'pass', 'convert', 'cancel', 'arrival', 'observer-cancel']),
    phase: z.enum([
      'queued',
      'scheduled',
      'sending',
      'uncertain',
      'applying',
      'completed',
      'reconciliation-required',
      'rejected',
    ]),
    version: z.number().int().positive(),
    outcome: z.enum([
      'pending',
      'created',
      'transferred',
      'converted',
      'cancelled',
      'arrival-scheduled',
      'already-recorded',
      'rejected',
    ]),
    nextStoreIds: z.array(legacyId).max(40),
    nextJobAt: z.number().int().safe().nonnegative().nullable(),
    newOrderId: legacyId.nullable(),
    courierOrderId: legacyId.nullable(),
    providerCallIds: z.array(z.uuid()).max(1004),
    auditIds: z.array(legacyId).max(1004),
    inventoryMovementCommandId: z.uuid().nullable(),
    createdAt: z.number().int().safe().positive(),
    updatedAt: z.number().int().safe().positive(),
    errorCode: z
      .enum([
        'PROVIDER_OUTCOME_UNKNOWN',
        'CURRENT_AUTHORITY_REQUIRED',
        'SOURCE_STATE_RECONCILIATION_REQUIRED',
        'DEPENDENCY_UNAVAILABLE',
        'PROVIDER_REJECTED',
        'INVENTORY_RECONCILIATION_REQUIRED',
      ])
      .nullable(),
    integrationState: z.enum(['not-required', 'pending', 'uncertain', 'delivered']),
    recoveryActorId: legacyId.nullable(),
    moneyHistoryId: legacyId.nullable(),
  })
  .strict();
export type DeliveryReceipt = z.infer<typeof deliveryReceipt>;
export const deliveryCapabilities = z
  .object({
    storeId: legacyId,
    orderId: legacyId,
    ownerStoreId: legacyId,
    checkedIn: z.boolean(),
    contractReady: z.boolean(),
    canCreate: z.boolean(),
    canPass: z.boolean(),
    canConvert: z.boolean(),
    canCancel: z.boolean(),
    activeCommand: deliveryReceipt.nullable(),
    arrivalRecorded: z.boolean(),
    reservationsVerified: z.boolean(),
    nextStoreIds: z.array(legacyId).max(40),
    workflowPending: z.boolean(),
    timeZone: z.string(),
  })
  .strict();
