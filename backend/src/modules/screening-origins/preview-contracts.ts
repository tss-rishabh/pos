import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { originHashSchema, screeningOriginSchema } from './contracts.js';

/** Server-issued preview authority. It cannot be parsed as an order command,
 * payment authority or a browser-provided capability. */
export const originPreviewSchema = z
  .object({
    contract: z.literal('pos-screening-origin-preview-v1'),
    previewId: z.uuid(),
    purpose: z.enum(['cart-mutation', 'order-cart-hydration', 'csk-cart-build']),
    origin: screeningOriginSchema,
    customerId: identifier,
    actorId: identifier.nullable(),
    storeId: identifier.nullable(),
    counterId: identifier.nullable(),
    authorityHash: originHashSchema,
    namespaceHash: originHashSchema,
    requestHash: originHashSchema,
    cartHash: originHashSchema,
    issuedAt: z.number().int().safe().positive(),
    expiresAt: z.number().int().safe().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    const staff = value.origin === 'legacy-django' || value.origin === 'mpos';
    if (
      [value.actorId, value.storeId, value.counterId].some((field) =>
        staff ? field === null : field !== null,
      ) ||
      value.expiresAt <= value.issuedAt ||
      value.expiresAt > value.issuedAt + 60000 ||
      (value.purpose === 'csk-cart-build' && value.origin !== 'external-system')
    )
      context.addIssue({ code: 'custom', message: 'Invalid preview authority.' });
  });
export type OriginPreview = z.infer<typeof originPreviewSchema>;
