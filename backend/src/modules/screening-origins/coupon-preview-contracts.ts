import { z } from 'zod';
import { originHashSchema } from './contracts.js';
import { originPreviewSchema } from './preview-contracts.js';
import { originCouponSelectionSchema } from './coupon-contracts.js';
import { couponHistoryWitnessSchema } from '../legacy-order-imports/benefit-profile/bridge.js';
import { couponPublicationFactsSchema } from '../legacy-order-imports/benefit-profile/history-publication.js';
export const originCouponPreviewContract = 'pos-screening-origin-coupon-preview-v1';
export const originCouponPreviewRequestSchema = z
  .object({
    preview: originPreviewSchema,
    previewProof: originHashSchema,
    selection: originCouponSelectionSchema,
    witness: couponHistoryWitnessSchema,
  })
  .strict();
export type OriginCouponPreviewRequest = z.infer<typeof originCouponPreviewRequestSchema>;
export const originCouponPreviewDocumentSchema = z
  .object({
    contract: z.literal(originCouponPreviewContract),
    preview: originPreviewSchema,
    previewProof: originHashSchema,
    selection: originCouponSelectionSchema,
    witness: couponHistoryWitnessSchema,
    generationId: originHashSchema,
    publication: z.object({ sourceCaptureHash: originHashSchema, seal: originHashSchema }).strict(),
    facts: couponPublicationFactsSchema,
    reader: z.literal('bigquery'),
    complete: z.literal(true),
    fetchedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
    signature: originHashSchema,
  })
  .strict();
