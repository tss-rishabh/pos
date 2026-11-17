import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { csvMembershipProvenanceSchema } from '../../legacy-order-imports/membership-profile/domain.js';

export const publicScreeningBenefitsContract = 'pos-node-screening-benefits-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicScreeningBenefitSchema = z
  .object({
    contract: z.literal(publicScreeningBenefitsContract),
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    actorId: identifier,
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    requestHash: hash,
    cartHash: hash,
    orderId: identifier,
    membership: z
      .object({
        kind: z.enum(['new', 'upgrade', 'auto-free']),
        productId: identifier,
        lineId: identifier,
        eligibility: z.enum([
          'not-added',
          'source-cart-over-2000',
          'source-qualified-history',
          'no-ordinary-items',
        ]),
        provenance: csvMembershipProvenanceSchema,
        cacheInvalidations: z.number().int().min(0).max(100),
        historyEvidence: z
          .object({
            generationId: hash,
            fetchedAt: z.number().int().positive().safe(),
            signature: hash,
            asOf: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
            cutoff: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
          })
          .strict()
          .nullable(),
        replacement: z
          .object({
            sourceAction: z.literal('AddFreeMembership.remove_exclusive_membership'),
            originalProductId: identifier,
            replacementProductId: identifier,
          })
          .strict()
          .optional(),
      })
      .strict()
      .nullable(),
    gifts: z
      .array(
        z
          .object({
            productId: identifier,
            serial: identifier,
            collectionId: identifier,
            initialAmount: z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/),
            voucherId: identifier,
            lineId: identifier,
            inputHash: hash,
          })
          .strict(),
      )
      .max(100),
    createdAt: z.number().int().positive().safe(),
  })
  .strict();
export type PublicScreeningBenefits = z.infer<typeof publicScreeningBenefitSchema>;
