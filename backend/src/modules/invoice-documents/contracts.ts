import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const invoiceIdentifier = identifier.refine(
  (value) => BigInt(value) <= 9223372036854775807n,
);
export const invoiceKind = z.enum(['store', 'online', 'same-day', 'express']);
export type InvoiceKind = z.infer<typeof invoiceKind>;
/** `global-online` is the legacy `?cr=1` cross-store access from an explicit order-ID search. */
export const invoiceDocumentScope = z
  .object({
    storeId: invoiceIdentifier,
    orderId: invoiceIdentifier,
    access: z.literal('global-online').optional(),
  })
  .strict();
export type InvoiceDocumentScope = z.infer<typeof invoiceDocumentScope>;
export const invoiceDocument = z
  .object({
    access: z.literal('global-online').optional(),
    kind: invoiceKind,
    storeId: invoiceIdentifier,
    orderId: invoiceIdentifier,
    number: z.string().max(255).nullable(),
    filename: z.string().regex(/^(?:(?:online|same-day|express)-)?tax-invoice-[1-9]\d*\.html$/),
    html: z.string().max(3_000_000),
  })
  .strict();
export type InvoiceDocument = z.infer<typeof invoiceDocument>;
export interface InvoiceCapabilities {
  access?: 'global-online';
  storeId: string;
  orderId: string;
  actions: { kind: 'online' | 'same-day' | 'express'; available: boolean }[];
}
