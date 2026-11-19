import { z } from 'zod';
import { request } from '../../api/client';
export const invoiceKind = z.enum(['store', 'online', 'same-day', 'express']);
export type InvoiceAccess = 'global-online';
const accessSchema = z.literal('global-online').optional();
export const invoiceAccessQuery = (access?: InvoiceAccess) =>
  accessSchema.parse(access) ? '?access=global-online' : '';
export type InvoiceKind = z.infer<typeof invoiceKind>;
const identifier = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const response = z
  .object({
    access: accessSchema,
    orderId: identifier,
    number: z.string().max(255).nullable(),
    filename: z.string().regex(/^(?:(?:online|same-day|express)-)?tax-invoice-[1-9]\d*\.html$/),
    html: z.string().max(3_000_000),
    kind: invoiceKind.optional(),
    storeId: identifier.optional(),
  })
  .strict();
export type InvoiceDocument = {
  kind: InvoiceKind;
  access?: InvoiceAccess;
  storeId: string;
  orderId: string;
  number: string | null;
  filename: string;
  html: string;
};
export function invoicePreviewPath(
  ownerId: string,
  storeId: string,
  orderId: string,
  kind: InvoiceKind,
  access?: InvoiceAccess,
) {
  identifier.parse(ownerId);
  identifier.parse(storeId);
  identifier.parse(orderId);
  invoiceKind.parse(kind);
  if (access && !['online', 'same-day'].includes(kind))
    throw new Error('Choose a supported global invoice.');
  return `/api/v1/operators/${ownerId}/stores/${storeId}/orders/${orderId}/invoices/${kind}/preview${invoiceAccessQuery(access)}`;
}
export async function readInvoiceDocument(
  ownerId: string,
  storeId: string,
  orderId: string,
  kind: InvoiceKind,
  signal: AbortSignal,
  access?: InvoiceAccess,
): Promise<InvoiceDocument> {
  identifier.parse(ownerId);
  identifier.parse(storeId);
  identifier.parse(orderId);
  invoiceKind.parse(kind);
  if (access && !['online', 'same-day'].includes(kind))
    throw new Error('Choose a supported global invoice.');
  const path = `/api/v1/stores/${storeId}/orders/${orderId}/invoices/${kind}${invoiceAccessQuery(access)}`;
  const document = await request(
    path,
    { operatorId: ownerId, signal, cache: 'no-store' },
    response,
  );
  signal.throwIfAborted();
  if (
    document.access !== access ||
    document.orderId !== orderId ||
    (document.storeId !== undefined && document.storeId !== storeId) ||
    (document.kind !== undefined && document.kind !== kind) ||
    document.filename !== `${kind === 'store' ? '' : `${kind}-`}tax-invoice-${orderId}.html` ||
    !document.html.includes('<meta name="pos-invoice" content="sanitized">') ||
    /<script\b/i.test(document.html)
  )
    throw new Error('The invoice document does not match this sale.');
  return { ...document, kind, storeId };
}
