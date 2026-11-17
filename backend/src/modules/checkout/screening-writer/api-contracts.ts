import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
export const publicScreeningScopeSchema = z
  .object({ storeId: identifier, checkoutId: z.uuid(), operationId: z.uuid() })
  .strict();
export type PublicScreeningScope = z.infer<typeof publicScreeningScopeSchema>;
export const publicScreeningViewSchema = z
  .object({
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    orderId: identifier.nullable(),
    status: z.enum([
      'prepared',
      'awaiting-source',
      'awaiting-payment',
      'completed',
      'abandoned',
      'closed-unsent',
      'source-rejected',
      'closed-no-order',
    ]),
    paymentReceiptId: z
      .string()
      .regex(/^[A-Za-z0-9:_-]{1,128}$/)
      .nullable(),
    publicationStatus: z
      .enum(['pending', 'processing', 'uncertain', 'accepted', 'cancelled', 'unavailable'])
      .nullable(),
    canAbandon: z.boolean(),
    canCloseNoOrder: z.boolean().optional(),
    benefits: z
      .object({
        membership: z.enum(['new', 'upgrade', 'auto-free']).nullable(),
        giftCards: z.number().int().min(0).max(100),
        restoration: z.enum(['unchanged', 'deactivated', 'prior-entitlement-restored']).optional(),
      })
      .strict()
      .optional(),
    benefitCacheStatus: z
      .enum(['pending', 'processing', 'uncertain', 'completed', 'cancelled'])
      .optional(),
    reviewCode: z
      .enum([
        'SCREENING_SOURCE_OUTCOME_UNKNOWN',
        'SCREENING_PUBLICATION_OUTCOME_UNKNOWN',
        'SCREENING_PAYMENT_RECONCILIATION_REQUIRED',
      ])
      .nullable(),
  })
  .strict();
export type PublicScreeningView = z.infer<typeof publicScreeningViewSchema>;
export const publicScreeningAbandonInputSchema = z
  .object({
    commandId: z.uuid(),
    reason: z.enum(['cash-abandoned', 'stock-unavailable', 'operator-revoked']),
  })
  .strict();
