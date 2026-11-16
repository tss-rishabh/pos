import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
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
export const returnOperationSchema = z.object({
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
    })
    .nullable()
    .default(null),
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
});
export type ReturnOperation = z.infer<typeof returnOperationSchema>;
export interface InboundReturn {
  locationCode: string;
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
