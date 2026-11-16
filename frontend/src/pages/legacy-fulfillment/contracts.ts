import { z } from 'zod';
export const legacyId = z.string().regex(/^[1-9]\d{0,19}$/);
export const legacyAction = z.enum(['packing', 'rto-receipt']);
export type LegacyAction = z.infer<typeof legacyAction>;
const step = z
  .object({
    hasProductId: legacyId,
    productId: legacyId,
    quantity: z.string().regex(/^[1-9]\d{0,18}$/),
    before: z.number().int(),
    after: z.number().int().nonnegative(),
  })
  .strict();
export const legacyReceipt = z
  .object({
    commandId: z.uuid(),
    actorId: legacyId,
    storeId: legacyId,
    orderId: legacyId,
    action: legacyAction,
    outcome: z.enum(['packed', 'rto-received', 'already-recorded']),
    originalCommandId: z.uuid().nullable(),
    recordedBy: z.enum(['rewrite', 'legacy']),
    auditId: legacyId.nullable(),
    restoredUnits: z.string().regex(/^\d{1,25}$/),
    split: z.boolean(),
    excludedLineCount: z.number().int().nonnegative().max(1000),
    steps: z.array(step).max(1000),
    syncEventId: z.uuid().nullable(),
    integrationState: z.enum(['not-required', 'pending', 'delivered', 'unconfirmed']),
    createdAt: z.number().int().safe().positive(),
    correctionContract: z.literal('pos-legacy-rto-same-store-hp-v1').nullable(),
  })
  .strict();
export type LegacyReceipt = z.infer<typeof legacyReceipt>;
export const legacyState = z
  .object({
    orderId: legacyId,
    storeId: legacyId,
    reference: z.string().nullable(),
    split: z.boolean(),
    sourceStatus: z.object({
      status: z.enum(['200', '400']),
      message: z.string(),
      error: z.string(),
    }),
    action: z
      .enum(['ACCEPTED', 'DECLINED', 'NO_ACTION', 'CREATION_FAILED', 'CONVERT_ONLINE'])
      .nullable(),
    borzoId: legacyId.nullable(),
    packed: z.boolean(),
    rtoReceived: z.boolean(),
    rtoEligible: z.boolean(),
    checkedIn: z.boolean(),
    workflowPending: z.boolean().default(false),
    reconciliationRequired: z.boolean(),
    rtoReady: z.boolean(),
    returnLines: z
      .array(
        z.object({
          id: legacyId,
          productId: legacyId,
          name: z.string().nullable(),
          quantity: z.string(),
        }),
      )
      .max(1000),
    excludedLineCount: z.number().int().nonnegative(),
    linesTruncated: z.boolean(),
    maxNoteCharacters: z.number().int().min(0).max(255),
    canPack: z.boolean(),
    canReceiveRto: z.boolean(),
    tracking: z.object({ source: z.url().nullable(), destination: z.url().nullable() }),
  })
  .strict();
