import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { legacyRestorationGroupSchema } from './legacy-restoration-group.js';
export const returnInputSchema = z
  .object({
    operationId: z.uuid(),
    counterId: identifier,
    verificationId: z.uuid(),
    reasonId: identifier,
    subReasonId: identifier.optional(),
    comment: z.string().max(255).default(''),
    qualityConfirmed: z.literal(true),
    tagConfirmed: z.literal(true),
    saleable: z.boolean(),
    refundMode: z.enum(['tss-money', 'cash']).default('tss-money'),
    overrideEligibility: z.boolean().default(false),
  })
  .strict();
export type ReturnInput = z.infer<typeof returnInputSchema>;
export const exchangeInputSchema = returnInputSchema
  .omit({ refundMode: true, overrideEligibility: true })
  .extend({ replacementProductId: identifier, salespersonId: identifier });
export type ExchangeInput = z.infer<typeof exchangeInputSchema>;
export const returnOperationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['return', 'exchange']).default('return'),
    exchange: z
      .object({
        newProductId: identifier,
        parentProductId: identifier,
        newSize: z.string(),
        oldSize: z.string().nullable(),
        salespersonId: identifier,
        logId: identifier,
        childOrderId: identifier.nullable(),
        sourceCounterId: z
          .string()
          .regex(/^(?:0|[1-9]\d{0,18})$/)
          .refine(
            (value) => /^(?:0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
          )
          .optional(),
        adoptionEvidence: z
          .preprocess(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              !Array.isArray(value) &&
              !Object.hasOwn(value, 'kind')
                ? { ...value, kind: 'single' }
                : value,
            z.discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('single'),
                  revision: z.string().regex(/^[a-f0-9]{64}$/),
                  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
                  creditId: identifier,
                  stockLogId: identifier,
                  stockLogKind: z.enum(['saleable', 'held']),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('group'),
                  revision: z.string().regex(/^[a-f0-9]{64}$/),
                  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
                  creditId: identifier,
                  group: legacyRestorationGroupSchema,
                })
                .strict(),
            ]),
          )
          .optional(),
      })
      .nullable()
      .default(null),
    authorityCounterId: identifier.optional(),
    recoveryClaim: z
      .object({
        id: z.uuid(),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        operatorId: identifier,
        counterId: identifier,
        verificationId: z.uuid(),
        claimedAt: z.string(),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    operatorId: identifier,
    storeId: identifier,
    orderId: identifier,
    lineId: identifier,
    productId: identifier,
    customerId: identifier,
    quantity: z.number().int().positive(),
    input: returnInputSchema,
    requestHash: z.string().length(64),
    phase: z.enum([
      'inbound-dispatching',
      'inbound-accepted',
      'refund-dispatching',
      'refund-confirmed',
      'old-item-restored',
      'replacement-dispatching',
      'replacement-rejected',
      'replacement-confirmed',
      'completed',
      'rejected',
      'uncertain',
    ]),
    uncertainStage: z.enum(['inbound', 'refund', 'replacement']).nullable(),
    creditNote: z.string().nullable(),
    returnAmount: z.string().nullable(),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .refine(
    (value) =>
      (!value.authorityCounterId && !value.recoveryClaim) ||
      (value.kind === 'exchange' && value.authorityCounterId === value.recoveryClaim?.counterId),
    'Recovery authority must match its durable claim.',
  )
  .refine(
    (value) =>
      !value.exchange?.sourceCounterId ||
      Boolean(value.exchange.adoptionEvidence && value.recoveryClaim),
    'Original financial counter requires verified legacy adoption.',
  );
export type ReturnOperation = z.infer<typeof returnOperationSchema>;
export interface InboundReturn {
  // Nullable stores.location_code; legacy sends kwargs.get('location_code') as-is
  // (helpers.py:1898), so NULL is serialised as JSON null.
  locationCode: string | null;
  orderId: string;
  trackingNumber: string | number | bigint;
  returnDate: string;
  customerName: string;
  address1: string;
  address2: string;
  state: string;
  city: string;
  pincode: string;
  remarks: string;
  productId: string;
  lineId: string;
  quantity: number;
  reason: string;
  exchange?: boolean;
}
export interface ReturnEligibility {
  reason?: string;
  allowed: boolean;
  until: string | null;
}
export interface ReturnGateway {
  configured(): void;
  sendOtp(customerId: string): Promise<void>;
  verifyOtp(customerId: string, otp: string): Promise<boolean>;
  eligibility(
    orderId: string,
    storeId: string,
    lineId: string,
    token: string,
    kind?: 'return' | 'exchange',
  ): Promise<ReturnEligibility>;
  inbound(value: InboundReturn): Promise<void>;
  refund(value: {
    customerId: string;
    orderId: string;
    productId: string;
    lineId: string;
    wallet: boolean;
    superAdmin: boolean;
  }): Promise<{ returnAmount: string }>;
}
export function publicReturn(value: ReturnOperation) {
  return {
    id: value.id,
    kind: value.kind,
    storeId: value.storeId,
    orderId: value.orderId,
    lineId: value.lineId,
    phase: value.phase,
    uncertainStage: value.uncertainStage,
    creditNote: value.creditNote,
    returnAmount: value.returnAmount,
    newOrderId: value.exchange?.childOrderId || null,
    replacement: value.exchange
      ? {
          productId: value.exchange.newProductId,
          size: value.exchange.newSize,
          salespersonId: value.exchange.salespersonId,
          reasonId: value.input.reasonId,
          subReasonId: value.input.subReasonId || null,
        }
      : null,
    errorCode: value.errorCode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

const returnWindowIdentifier = identifier.refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  'Identifier exceeds the native return-extension storage range.',
);
export const returnWindowScopeSchema = z
  .object({
    counterId: returnWindowIdentifier,
    verificationId: z.uuid(),
    productId: returnWindowIdentifier,
  })
  .strict();
export const returnWindowPathSchema = z
  .object({
    storeId: returnWindowIdentifier,
    orderId: returnWindowIdentifier,
    lineId: returnWindowIdentifier,
  })
  .strict();
export const returnWindowInputSchema = returnWindowScopeSchema
  .extend({
    date: z.iso.date(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ReturnWindowScope = z.infer<typeof returnWindowScopeSchema>;
export type ReturnWindowInput = z.infer<typeof returnWindowInputSchema>;

/** The immutable provider/native financial counter may be zero in original failed exchanges. */
export function exchangeFinancialCounter(operation: ReturnOperation): string {
  return operation.exchange?.sourceCounterId ?? operation.input.counterId;
}
const recoveryIdentifier = identifier.refine(
  (value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
);
export const exchangeRecoveryPath = z
  .object({ storeId: recoveryIdentifier, orderId: recoveryIdentifier, lineId: recoveryIdentifier })
  .strict();
export const exchangeRecoveryScope = z
  .object({ counterId: recoveryIdentifier, verificationId: z.uuid() })
  .strict();
export const exchangeRecoveryClaim = exchangeRecoveryScope
  .extend({
    operationId: z.uuid(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    salespersonId: recoveryIdentifier.optional(),
  })
  .strict();
export type ExchangeRecoveryScope = z.infer<typeof exchangeRecoveryScope>;
export type ExchangeRecoveryClaim = z.infer<typeof exchangeRecoveryClaim>;
