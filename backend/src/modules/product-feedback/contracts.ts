import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { customerProfileScope } from '../customer-insights/contracts.js';
import { isLegacyLatinText } from '../checkout/settlement-note.js';

// The source business tables use signed BIGINTs; never round them through Number.
export const feedbackIdentifier = identifier.refine(
  (value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
);
export const productFeedbackScope = customerProfileScope
  .extend({
    storeId: feedbackIdentifier,
    customerId: feedbackIdentifier,
    orderId: feedbackIdentifier,
  })
  .strict();
export type ProductFeedbackScope = z.infer<typeof productFeedbackScope>;
export const feedbackPage = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    after: feedbackIdentifier.optional(),
  })
  .strict();
const rating = z
  .number()
  .min(0)
  .max(5)
  .refine(
    (value) =>
      Number.isInteger(Math.round(value * 10)) &&
      Math.abs(value * 10 - Math.round(value * 10)) < 1e-9,
    'Use increments of 0.1.',
  );
export const feedbackSubmission = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    productId: feedbackIdentifier,
    overall: rating,
    fit: rating.default(0),
    size: rating.default(0),
    quality: rating.default(0),
    comment: z
      .string()
      .max(255)
      .refine(isLegacyLatinText, 'Use text supported by the product feedback system.')
      .default(''),
  })
  .strict();
export type FeedbackSubmission = z.infer<typeof feedbackSubmission>;
export const existingFeedback = z
  .object({
    id: feedbackIdentifier,
    optionId: z
      .string()
      .regex(/^-?\d{1,19}$/)
      .nullable(),
    rating: z.number().nullable(),
    platform: z.string().max(8).nullable(),
    comment: z.string().max(255).nullable(),
  })
  .strict();
export const feedbackWorkspace = z
  .object({
    customerId: feedbackIdentifier,
    checkoutVersion: z.number().int().nonnegative(),
    orderId: feedbackIdentifier,
    orderAmount: z.number(),
    editable: z.boolean(),
    items: z
      .array(
        z
          .object({
            lineId: feedbackIdentifier,
            productId: feedbackIdentifier,
            name: z.string().max(255),
            feedback: z.array(existingFeedback).max(1000),
          })
          .strict(),
      )
      .max(50),
    nextCursor: feedbackIdentifier.nullable(),
  })
  .strict();
export const feedbackReceipt = z
  .object({
    operationId: z.uuid(),
    customerId: feedbackIdentifier,
    checkoutId: z.uuid(),
    checkoutVersion: z.number().int().nonnegative(),
    orderId: feedbackIdentifier,
    productId: feedbackIdentifier,
    ratingIds: z.array(feedbackIdentifier).length(4),
    appliedAt: z.iso.datetime(),
  })
  .strict();
export type FeedbackReceipt = z.infer<typeof feedbackReceipt>;

/** Preserve the source view's rotation, including partial and duplicate options. */
export function sourceFeedbackOrder<T>(rows: readonly T[]): T[] {
  return [...rows.slice(1), ...rows.slice(0, 1)];
}
