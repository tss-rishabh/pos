import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-primitives.js';
import type { ImportFinancialState, SourceOrderReceipt } from '../financial-adapter-contracts.js';
import { benefitDigest } from './crypto.js';

export const automaticCouponContract = 'pos-csv-automatic-coupon-v1';
export const complementaryContract = 'pos-csv-pos-complementary-v1';
export const benefitSourceCommit = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5';
export const benefitHash = z.string().regex(/^[a-f0-9]{64}$/);
export const benefitAmount = z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/);
export const benefitCount = z.string().regex(/^(?:0|[1-9]\d{0,18})$/);
export const benefitTimestamp = z
  .string()
  .regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  .refine((value) => {
    try {
      Temporal.PlainDateTime.from(value.replace(' ', 'T'), { overflow: 'reject' });
      return true;
    } catch {
      return false;
    }
  });
export const benefitLineSchema = z
  .object({
    id: identifier,
    productId: identifier,
    quantity: z.number().int().min(1).max(999),
    inputHash: benefitHash,
  })
  .strict();
export const benefitScopeSchema = z
  .object({
    operationId: z.uuid(),
    requestHash: benefitHash,
    planHash: benefitHash,
    actorId: identifier,
    authorityHash: benefitHash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    orderId: identifier,
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    method: z.union([z.literal(14), z.literal(15)]),
    sourceCommit: z.literal(benefitSourceCommit),
    headerHash: benefitHash,
    lineHash: benefitHash,
    /** Source execution wall time; never the historical CSV business date. */
    asOf: benefitTimestamp,
  })
  .strict();
export const couponAllocationSchema = benefitLineSchema
  .extend({
    discount: benefitAmount,
    refundable: benefitAmount,
    refundInputHash: benefitHash,
  })
  .strict();
const couponUserState = z
  .object({
    id: identifier,
    allowed: benefitCount,
    used: benefitCount,
    monthlyAllowed: benefitCount,
    inputHash: benefitHash,
  })
  .strict();
export const automaticCouponReceiptSchema = z
  .object({
    contract: z.literal(automaticCouponContract),
    scope: benefitScopeSchema,
    trigger: z.literal('automatic-birthday'),
    couponId: identifier,
    configurationHash: benefitHash,
    couponInputHash: benefitHash,
    history: z
      .object({ generationId: benefitHash, documentHash: benefitHash, scopeHash: benefitHash })
      .strict(),
    /** A real cooperative claim, not an invented cache-miss or a caller consent flag. */
    birthdayClaim: z
      .object({
        id: z.uuid(),
        keyHash: benefitHash,
        receiptHash: benefitHash,
        expiresAt: z.number().int().safe().positive(),
      })
      .strict(),
    cartCouponDiscount: benefitAmount,
    headerCouponId: identifier.nullable(),
    headerCouponAmount: benefitAmount.nullable(),
    consumption: z.enum(['offline-go-confirmation', 'shopify-none']),
    couponUsersBefore: z.array(couponUserState).max(1000),
    allocations: z.array(couponAllocationSchema).min(1).max(1000),
    refundAllocationContract: z.literal('pos-refund-per-hp-v1'),
    refundSourcePatchHash: z.literal(
      'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.scope.method === 14
        ? value.consumption !== 'offline-go-confirmation' ||
          value.headerCouponId !== value.couponId ||
          value.headerCouponAmount !== value.cartCouponDiscount
        : value.consumption !== 'shopify-none' || value.headerCouponId !== null
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Coupon consumption must match the original importer.',
      });
    for (const rows of [value.allocations, value.couponUsersBefore])
      if (new Set(rows.map((row) => row.id)).size !== rows.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate benefit evidence.' });
  });
export type AutomaticCouponReceipt = z.infer<typeof automaticCouponReceiptSchema>;
export const posComplementaryReceiptSchema = z
  .object({
    contract: z.literal(complementaryContract),
    scope: benefitScopeSchema,
    /** POS skips web auto-freebie wrappers. These are selections already in the original CSV. */
    origin: z.literal('original-csv-pos-selection'),
    selections: z
      .array(
        z
          .object({
            productId: identifier,
            declaredQuantity: z.number().int().min(1).max(999),
            declaredUnitPrice: benefitAmount,
            sourceRows: z.array(z.number().int().positive()).min(1).max(1000),
            productInputHash: benefitHash,
            catalogBasePrice: benefitAmount,
            priceRule: z.enum(['source-zero-per-unit', 'source-base-aggregate']),
            line: benefitLineSchema
              .extend({
                quantity: z.literal(1),
                price: benefitAmount,
                type: z.literal('FREEBIE'),
                refundable: benefitAmount,
                refundInputHash: benefitHash,
              })
              .strict(),
            grant: z
              .object({
                id: identifier,
                inputHash: benefitHash,
                level: z.literal('POS_MANUAL'),
                triggerKey: z.literal('pos_manual:0'),
                status: z.literal('ACTIVE'),
                triggerCount: z.literal(0),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    additionalLines: z.array(z.never()).length(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.selections.map((row) => row.productId)).size !== value.selections.length ||
      new Set(value.selections.map((row) => row.line.id)).size !== value.selections.length ||
      new Set(value.selections.map((row) => row.grant.id)).size !== value.selections.length ||
      value.selections.some((row) => row.productId !== row.line.productId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Complementary evidence must identify each actual line and grant.',
      });
  });
export type PosComplementaryReceipt = z.infer<typeof posComplementaryReceiptSchema>;

export const couponActivationSchema = z
  .object({
    contract: z.literal('pos-csv-coupon-consumption-v1'),
    scope: benefitScopeSchema,
    stagedReceiptHash: benefitHash,
    couponId: identifier,
    sourceConfirmationHash: benefitHash,
    /** Captured around the existing Go deduction, inside its existing writer transaction. */
    changes: z
      .array(
        z
          .object({
            id: identifier,
            before: benefitCount,
            after: benefitCount,
            inputHash: benefitHash,
          })
          .strict(),
      )
      .max(1000),
    log: z.object({ id: identifier, inputHash: benefitHash, status: z.literal(1) }).strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.scope.method === 14 &&
      new Set(value.changes.map((row) => row.id)).size === value.changes.length &&
      value.changes.every((row) => BigInt(row.after) === BigInt(row.before) + 1n),
  );
export type CouponActivation = z.infer<typeof couponActivationSchema>;

export function benefitError() {
  return importFinancialError('ORDER_IMPORT_BENEFIT_PROOF_INVALID');
}
export function benefitReceiptHash(
  kind: 'coupon' | 'complementary' | 'coupon-consumption',
  value: unknown,
  key: string,
) {
  return benefitDigest(kind, value, key);
}
export function benefitAuthorityHash(state: ImportFinancialState, key: string) {
  return benefitDigest('authority', state.authority, key);
}
export function assertBenefitScope(
  scope: z.infer<typeof benefitScopeSchema>,
  state: ImportFinancialState,
  order: SourceOrderReceipt,
  key: string,
) {
  if (
    scope.operationId !== state.scope.operationId ||
    scope.operationId !== order.operationId ||
    scope.requestHash !== state.requestHash ||
    scope.requestHash !== order.requestHash ||
    scope.planHash !== state.planHash ||
    scope.actorId !== state.scope.actorId ||
    scope.authorityHash !== benefitAuthorityHash(state, key) ||
    scope.namespace !== state.namespace ||
    scope.namespace !== order.namespace ||
    scope.orderId !== order.orderId ||
    scope.customerId !== state.authority.customerId ||
    scope.customerId !== order.customerId ||
    scope.storeId !== state.scope.storeId ||
    scope.storeId !== order.storeId ||
    scope.counterId !== state.scope.counterId ||
    scope.counterId !== order.counterId ||
    scope.method !== order.method ||
    scope.headerHash !== order.headerHash ||
    scope.lineHash !== order.lineHash
  )
    throw benefitError();
}
export function verifyBenefitSeal(
  kind: Parameters<typeof benefitReceiptHash>[0],
  value: unknown,
  seal: string,
  key: string,
) {
  if (
    Buffer.byteLength(key) < 32 ||
    Buffer.byteLength(key) > 4096 ||
    !equalImportHash(benefitReceiptHash(kind, value, key), seal)
  )
    throw benefitError();
}
