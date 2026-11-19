import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import type { ExchangeCell, ExchangeCellFacts } from './exchange-cell.js';

/**
 * `AjaxProductReturnView` input (order/views.py:885-906). `quality_check`/`tag_check` are not
 * saved; the template refuses only when both are unchecked (show.html:1262 "Please select
 * checkboxes"). `click_type` is `normal` (return button) or `extreme` (force return).
 */
export const returnInputSchema = z
  .object({
    operationId: z.uuid(),
    counterId: identifier,
    reasonId: identifier,
    subReasonId: identifier.optional(),
    comment: z.string().max(255).default(''),
    qualityConfirmed: z.boolean(),
    tagConfirmed: z.boolean(),
    saleable: z.boolean(),
    refundMode: z.enum(['tss-money', 'cash']).default('tss-money'),
    overrideEligibility: z.boolean().default(false),
    clickType: z.enum(['normal', 'extreme']).default('normal'),
  })
  .strict()
  .refine((value) => value.qualityConfirmed || value.tagConfirmed, {
    message: 'Please select checkboxes',
    path: ['qualityConfirmed'],
  });
export type ReturnInput = z.infer<typeof returnInputSchema>;
export const exchangeInputSchema = z
  .object({
    operationId: z.uuid(),
    counterId: identifier,
    reasonId: identifier,
    subReasonId: identifier.optional(),
    comment: z.string().max(255).default(''),
    qualityConfirmed: z.boolean(),
    tagConfirmed: z.boolean(),
    saleable: z.boolean(),
    replacementProductId: identifier,
    salespersonId: identifier,
  })
  .strict()
  .refine((value) => value.qualityConfirmed || value.tagConfirmed, {
    message: 'Please select checkboxes',
    path: ['qualityConfirmed'],
  });
export type ExchangeInput = z.infer<typeof exchangeInputSchema>;

const phases = [
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
] as const;

/** Redis `pos:return_op:{id}` (state.ts). Durable facts live in the legacy tables. */
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
      /** pos_exchange_log.id */
      logId: identifier,
      childOrderId: identifier.nullable(),
      /** Legacy retry sends the stored `counter_id or 0` (order/views.py:1071). */
      sourceCounterId: z
        .string()
        .regex(/^(?:0|[1-9]\d{0,18})$/)
        .optional(),
    })
    .nullable()
    .default(null),
  /** S35 facts read when the operation began: store or online order, CURRENT product type. */
  guard: z
    .object({ variant: z.enum(['store', 'online']), productType: z.number().int().nullable() })
    .strict()
    .optional(),
  /** The counter of the operator who claimed a recovery (current check-in). */
  authorityCounterId: identifier.optional(),
  recoveryClaim: z
    .object({
      id: z.uuid(),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      operatorId: identifier,
      counterId: identifier,
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
  input: z.object({
    operationId: z.uuid(),
    counterId: identifier,
    reasonId: identifier,
    subReasonId: identifier.optional(),
    comment: z.string().max(255),
    qualityConfirmed: z.boolean(),
    tagConfirmed: z.boolean(),
    saleable: z.boolean(),
    refundMode: z.enum(['tss-money', 'cash']),
    overrideEligibility: z.boolean(),
    clickType: z.enum(['normal', 'extreme']).default('normal'),
  }),
  requestHash: z.string().length(64),
  phase: z.enum(phases),
  uncertainStage: z.enum(['inbound', 'refund', 'replacement']).nullable(),
  creditNote: z.string().nullable(),
  returnAmount: z.string().nullable(),
  /** Python repr of the API return_amount, as `return_transaction_logger` stores it. */
  returnAmountRepr: z.string().max(64).nullable().default(null),
  errorCode: z.string().nullable(),
  /** The legacy flash message shown for the last outcome, when legacy shows one. */
  message: z.string().max(1024).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
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
/** One line of `Helpers.check_return_exchange_status` (helpers/helpers.py:1723-1777). */
export interface LineEligibility {
  return: { status: boolean; reason: string; upto: string | null };
  exchange: { status: boolean; reason: string; upto: string | null };
}
export interface ReturnEligibility {
  reason?: string;
  allowed: boolean;
  until: string | null;
}
export type RefundOutcome =
  | { kind: 'refunded'; returnAmount: string; returnAmountRaw: string | number }
  | { kind: 'already-refunded' };
export interface ReturnGateway {
  configured(): void;
  /** All lines of the order; empty map when legacy would render "Check-in first". */
  orderEligibility(
    orderId: string,
    storeId: string,
    token: string,
  ): Promise<Map<string, LineEligibility>>;
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
  }): Promise<RefundOutcome>;
  /** `Helpers.return_order` (helpers/helpers.py:600-610): inline, failures only logged. */
  returnMail(value: {
    orderId: string;
    productId: string;
    storeId: string;
    lineId: string;
  }): Promise<void>;
  /** `Helpers.notify_exchange_order_email` (helpers/helpers.py:1203-1209): inline, failures only logged. */
  exchangeMail(value: { orderId: string; productId: string; lineId: string | null }): Promise<void>;
  /** `Helpers.slack_text_notification` (helpers/helpers.py:1093-1131) to the store channel. */
  slack(value: {
    message: string;
    storeId: string;
    staffUser: string;
    storeSlackUrl: string | null;
  }): Promise<void>;
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
    message: value.message,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Per-line eligibility response: everything needed to choose the legacy cell branch. */
export interface LineEligibilityView {
  orderId: string;
  lineId: string;
  kind: 'return' | 'exchange';
  allowed: boolean;
  until: string | null;
  reason: string;
  overrideAvailable: boolean;
  /** `exchange_feature_enabled` of the operator's check-in store (EXCHANGE_ENABLED_STORE_IDS). */
  exchangeFeatureEnabled: boolean;
  facts: ExchangeCellFacts & { returnStatus: number; merged: boolean };
  cell: ExchangeCell;
}

const returnWindowIdentifier = identifier.refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  'Identifier exceeds the native return-extension storage range.',
);
export const returnWindowScopeSchema = z
  .object({
    counterId: returnWindowIdentifier,
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

/** The stored legacy counter (may be zero) for a recovered exchange, else the request counter. */
export function exchangeFinancialCounter(operation: ReturnOperation): string {
  return operation.exchange?.sourceCounterId ?? operation.input.counterId;
}
const recoveryIdentifier = identifier.refine(
  (value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
);
export const exchangeRecoveryPath = z
  .object({ storeId: recoveryIdentifier, orderId: recoveryIdentifier, lineId: recoveryIdentifier })
  .strict();
export const exchangeRecoveryScope = z.object({ counterId: recoveryIdentifier }).strict();
export const exchangeRecoveryClaim = exchangeRecoveryScope
  .extend({
    operationId: z.uuid(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    salespersonId: recoveryIdentifier.optional(),
  })
  .strict();
export type ExchangeRecoveryScope = z.infer<typeof exchangeRecoveryScope>;
export type ExchangeRecoveryClaim = z.infer<typeof exchangeRecoveryClaim>;
