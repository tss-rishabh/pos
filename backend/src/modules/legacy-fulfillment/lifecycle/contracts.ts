import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { legacyRtoCorrectionContract, rtoStepSchema } from '../domain.js';

export const commandId = z.uuid().transform((value) => value.toLowerCase());
export const lifecycleAction = z.enum([
  'create',
  'pass',
  'convert',
  'cancel',
  'arrival',
  'observer-cancel',
]);
export type LifecycleAction = z.infer<typeof lifecycleAction>;
export const lifecycleInput = z
  .object({
    commandId,
    reason: z.string().max(255).default(''),
    reasonCategory: z.string().max(255).default(''),
    notify: z.boolean().default(false),
    notificationTitle: z.string().min(1).max(200).default('Hyperlocal Order'),
  })
  .strict();
export type LifecycleInput = z.infer<typeof lifecycleInput>;
export const lifecycleActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), id: identifier }).strict(),
  z.object({ kind: z.literal('service'), id: z.literal('service') }).strict(),
]);
export type LifecycleActor = z.infer<typeof lifecycleActor>;
export const deliverySnapshot = z
  .object({
    orderId: identifier,
    customerId: identifier,
    ownerStoreId: identifier,
    split: z.boolean(),
    nextStoreIds: z.array(identifier).max(40),
    rawNextIds: z.string().max(255),
    cancellationBaselineId: identifier.nullable().default(null),
    startTimeslot: z.string().nullable(),
    isTransferred: z.boolean(),
    lines: z
      .array(
        z
          .object({
            id: identifier,
            productId: identifier,
            quantity: z.number().int().min(1).max(2147483647),
            platform: z.string(),
            status: z.string().max(55),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type DeliverySnapshot = z.infer<typeof deliverySnapshot>;
export const lifecyclePhase = z.enum([
  'queued',
  'scheduled',
  'sending',
  'uncertain',
  'applying',
  'completed',
  'reconciliation-required',
  'rejected',
]);
export const lifecycleReceipt = z
  .object({
    commandId,
    actorId: z.union([identifier, z.literal('service')]),
    storeId: identifier,
    orderId: identifier,
    action: lifecycleAction,
    phase: lifecyclePhase,
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
    nextStoreIds: z.array(identifier).max(40),
    nextJobAt: z.number().int().safe().nonnegative().nullable(),
    newOrderId: identifier.nullable(),
    courierOrderId: identifier.nullable(),
    providerCallIds: z.array(commandId).max(1004),
    auditIds: z.array(identifier).max(1004),
    inventoryMovementCommandId: commandId.nullable(),
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
    integrationState: z
      .enum(['not-required', 'pending', 'uncertain', 'delivered'])
      .default('not-required'),
    recoveryActorId: identifier.nullable().default(null),
    moneyHistoryId: identifier.nullable().default(null),
  })
  .strict();
export type LifecycleReceipt = z.infer<typeof lifecycleReceipt>;
export const reservation = z
  .object({
    storeId: identifier,
    hasProductId: identifier,
    productId: identifier,
    quantity: z.number().int().min(1).max(2147483647),
    state: z.enum(['held', 'released', 'consumed']),
    commandId,
  })
  .strict();
export type Reservation = z.infer<typeof reservation>;
export const lifecycleOrderState = z
  .object({
    version: z.literal(1),
    orderId: identifier,
    initialStoreId: identifier,
    activeCommandId: commandId.nullable(),
    reservations: z.array(reservation).max(41000),
    acceptedStoreId: identifier.nullable(),
    arrivalCommandId: commandId.nullable(),
    rtoCommandId: commandId.nullable().default(null),
    cancellationCommandId: commandId.nullable().default(null),
    convertedCommandId: commandId.nullable().default(null),
  })
  .strict();
export type LifecycleOrderState = z.infer<typeof lifecycleOrderState>;
export const cancellationMovement = z
  .object({
    kind: z.literal('local-delivery-cancellation'),
    version: z.literal(1),
    commandId,
    actorId: z.union([identifier, z.literal('service')]),
    storeId: identifier,
    orderId: identifier,
    correctionContract: z.literal(legacyRtoCorrectionContract),
    steps: z.array(rtoStepSchema).max(1000),
    restoredUnits: z.string().regex(/^\d{1,25}$/),
    auditId: identifier,
    createdAt: z.number().int().safe().positive(),
  })
  .strict();
export type CancellationMovement = z.infer<typeof cancellationMovement>;
export const providerKind = z.enum([
  'borzo-create',
  'online-convert',
  'cancel-order',
  'cancel-item',
  'split-charge-refund',
  'order-producer',
  'new-order-email',
  'support-ticket',
  'slack',
]);
export type ProviderKind = z.infer<typeof providerKind>;
export const providerRequest = z
  .object({
    id: commandId,
    commandId,
    kind: providerKind,
    orderId: identifier,
    storeId: identifier,
    customerId: identifier,
    productId: identifier.nullable(),
    split: z.boolean(),
    reason: z.string().max(255),
    platform: z.enum(['', 'webhook', 'CONVERT_ONLINE', 'RTO_CONVERT_ONLINE']),
    newOrderId: identifier.nullable(),
    subject: z.string().max(255),
    description: z.string().max(2000),
    customerName: z.string().max(64).default(''),
    slackDestination: z.enum(['common', 'store']).default('common'),
    slackDestinationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type ProviderRequest = z.infer<typeof providerRequest>;
export const providerResult = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('courier-created'),
      courierOrderId: identifier,
      sourceTracking: z.string().max(255).nullable(),
      destinationTracking: z.string().max(255).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('online-created'),
      newOrderId: identifier,
      hlCharges: z.number().finite().nonnegative().max(2147483647),
    })
    .strict(),
  z.object({ kind: z.literal('acknowledged') }).strict(),
  z.object({ kind: z.literal('rejected'), noSideEffects: z.literal(true) }).strict(),
]);
export type ProviderResult = z.infer<typeof providerResult>;
export const providerObservation = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      result: providerResult,
    })
    .strict(),
  z
    .object({
      status: z.literal('not-sent'),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      safeToSend: z.literal(true),
    })
    .strict(),
  z.object({ status: z.literal('unknown') }).strict(),
]);
export type ProviderObservation = z.infer<typeof providerObservation>;
