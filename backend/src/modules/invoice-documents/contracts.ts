import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const invoiceIdentifier = identifier.refine(
  (value) => BigInt(value) <= 9223372036854775807n,
);
export const invoiceDocumentScope = z
  .object({
    storeId: invoiceIdentifier,
    orderId: invoiceIdentifier,
    access: z.literal('global-online').optional(),
  })
  .strict();
export type InvoiceDocumentScope = z.infer<typeof invoiceDocumentScope>;
export const onlineInvoiceDocument = z
  .object({
    access: z.literal('global-online').optional(),
    kind: z.literal('online'),
    storeId: invoiceIdentifier,
    orderId: invoiceIdentifier,
    number: z.string().max(255).nullable(),
    filename: z.string().regex(/^online-tax-invoice-[1-9]\d*\.html$/),
    html: z.string().max(3_000_000),
  })
  .strict();
export type OnlineInvoiceDocument = z.infer<typeof onlineInvoiceDocument>;
export const maxInvoiceLines = 10_000;

export interface InvoiceLineScope {
  id: string;
  platformId: string;
}
export interface InvoiceMappingScope {
  id: string;
  storeId: string;
  counterId: string;
  // order_stores.order_invoice is nullable in production.
  number: string | null;
}
export interface InvoiceExpressScope {
  id: string;
  lineId: string;
  storeId: string | null;
}
export interface InvoiceOwnership {
  storeId: string;
  locationType: string;
  locationId: string | null;
  split: boolean;
  lines: readonly InvoiceLineScope[];
  mappings: readonly InvoiceMappingScope[];
  express: readonly InvoiceExpressScope[];
}
/** A full invoice cannot borrow authorization from one line of a mixed order. */
export function fullInvoiceOwnership(
  value: InvoiceOwnership,
): 'store' | 'express' | 'local' | null {
  if (
    !value.lines.length ||
    value.lines.length > maxInvoiceLines ||
    value.express.length > maxInvoiceLines ||
    value.mappings.length > 1
  )
    return null;
  const ids = new Set(value.lines.map((line) => line.id));
  if (
    ids.size !== value.lines.length ||
    value.express.some((line) => !ids.has(line.lineId) || line.storeId !== value.storeId)
  )
    return null;
  if (value.mappings.length === 1)
    return value.mappings[0]!.storeId === value.storeId ? 'store' : null;
  if (value.express.length) {
    const mapped = new Set(value.express.map((line) => line.lineId));
    return mapped.size === ids.size ? 'express' : null;
  }
  return value.locationType === 'SW' &&
    value.locationId === value.storeId &&
    !value.split &&
    value.lines.every((line) => line.platformId === '4')
    ? 'local'
    : null;
}

export const additionalInvoiceKind = z.enum(['online', 'same-day', 'express']);
export type AdditionalInvoiceKind = z.infer<typeof additionalInvoiceKind>;
export const scopedInvoiceDocument = z
  .object({
    access: z.literal('global-online').optional(),
    kind: z.enum(['same-day', 'express']),
    storeId: invoiceIdentifier,
    orderId: invoiceIdentifier,
    number: z.string().max(255).nullable(),
    filename: z.string().regex(/^(?:same-day|express)-tax-invoice-[1-9]\d*\.html$/),
    html: z.string().max(3_000_000),
  })
  .strict();
