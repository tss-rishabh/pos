import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { originCommandSchema, originHashSchema } from './contracts.js';
import { couponHistoryWitnessSchema } from '../legacy-order-imports/benefit-profile/bridge.js';
import { couponPublicationFactsSchema } from '../legacy-order-imports/benefit-profile/history-publication.js';
import { benefitTimestamp } from '../legacy-order-imports/benefit-profile/contracts.js';
export const originCouponContract = 'pos-screening-origin-coupon-v1';
export const originCouponHistoryContract = 'pos-screening-origin-coupon-history-v1';
const point = z.number().int().positive().safe();
export const originCouponSelectionSchema = z
  .object({
    couponId: identifier,
    configurationHash: originHashSchema,
    originConfigurationHash: originHashSchema,
    couponInputHash: originHashSchema,
    asOf: benefitTimestamp,
    sourceTimeZone: z.string().min(1).max(100),
  })
  .strict();
export const originCouponHistoryRequestSchema = z
  .object({
    command: originCommandSchema,
    commandProof: originHashSchema,
    selection: originCouponSelectionSchema,
    witness: couponHistoryWitnessSchema,
    issuedAt: point,
    expiresAt: point,
  })
  .strict();
export type OriginCouponHistoryRequest = z.infer<typeof originCouponHistoryRequestSchema>;
export const originCouponHistoryDocumentSchema = z
  .object({
    contract: z.literal(originCouponHistoryContract),
    commandId: z.uuid(),
    origin: originCommandSchema.shape.origin,
    customerId: identifier,
    requestHash: originHashSchema,
    cartHash: originHashSchema,
    authorityHash: originHashSchema,
    selection: originCouponSelectionSchema,
    witness: couponHistoryWitnessSchema,
    generationId: originHashSchema,
    publication: z.object({ sourceCaptureHash: originHashSchema, seal: originHashSchema }).strict(),
    facts: couponPublicationFactsSchema,
    reader: z.literal('bigquery'),
    complete: z.literal(true),
    fetchedAt: point,
    expiresAt: point,
    signature: originHashSchema,
  })
  .strict();
export type OriginCouponHistoryDocument = z.infer<typeof originCouponHistoryDocumentSchema>;
const count = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const money = z.string().regex(/^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/);
const users = z
  .array(
    z
      .object({
        id: identifier,
        allowed: count,
        used: count,
        monthlyAllowed: count,
        inputHash: originHashSchema,
      })
      .strict(),
  )
  .max(1000);
export const originCouponReceiptSchema = z
  .object({
    contract: z.literal(originCouponContract),
    sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
    commandId: z.uuid(),
    origin: originCommandSchema.shape.origin,
    actorId: identifier.nullable(),
    customerId: identifier,
    storeId: identifier.nullable(),
    counterId: identifier.nullable(),
    authorityHash: originHashSchema,
    requestHash: originHashSchema,
    cartHash: originHashSchema,
    namespaceHash: originHashSchema,
    orderId: identifier,
    headerHash: originHashSchema,
    couponId: identifier,
    couponInputHash: originHashSchema,
    configurationHash: originHashSchema,
    originConfigurationHash: originHashSchema,
    historyRequirement: z.enum(['current-controls', 'bigquery']),
    history: z
      .object({
        generationId: originHashSchema,
        documentHash: originHashSchema,
        witnessHash: originHashSchema,
      })
      .strict()
      .nullable(),
    birthdayClaim: z
      .object({
        id: z.uuid(),
        keyHash: originHashSchema,
        receiptHash: originHashSchema,
        expiresAt: point,
      })
      .strict()
      .nullable(),
    cartCouponDiscount: money,
    headerCouponAmount: money,
    consumption: z.enum(['source-prepaid', 'go-confirmation']),
    couponUsersBefore: users,
    couponUsersAfter: users,
    sourceLog: z
      .object({ id: identifier, inputHash: originHashSchema, status: z.literal(1) })
      .strict()
      .nullable(),
    allocations: z
      .array(
        z
          .object({
            id: identifier,
            productId: identifier,
            quantity: z.number().int().min(1).max(1000),
            inputHash: originHashSchema,
            discount: money,
            refundable: money,
            refundInputHash: originHashSchema,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    welcomeConsent: z
      .object({
        contract: z.literal('pos-screening-origin-welcome-consent-v1'),
        customerId: identifier,
        customerInputHash: originHashSchema,
        eligible: z.boolean(),
        rows: z.array(z.object({ id: identifier, inputHash: originHashSchema }).strict()).max(1000),
      })
      .strict()
      .optional(),
    createdAt: point,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.historyRequirement === 'bigquery') !== (value.history !== null) ||
      (value.historyRequirement === 'current-controls' && value.birthdayClaim !== null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Coupon history evidence does not match its source branch',
      });
  });
