import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { invoiceIdentifier } from './contracts.js';
export const invoicePreviewScope = z
  .object({
    access: z.literal('global-online').optional(),
    operatorId: invoiceIdentifier,
    storeId: invoiceIdentifier,
    orderId: invoiceIdentifier,
    kind: z.enum(['store', 'online', 'same-day', 'express']),
  })
  .strict();
export type InvoicePreviewScope = z.infer<typeof invoicePreviewScope>;
const attribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
/** Static scope metadata is inserted only into the already sanitized trusted wrapper. */
export function invoicePreviewHtml(html: string, raw: InvoicePreviewScope, number: string | null) {
  const scope = invoicePreviewScope.parse(raw),
    marker = '<meta name="pos-invoice" content="sanitized">';
  if (!html.includes(marker))
    throw new AppError(
      502,
      'INVOICE_RESPONSE_INVALID',
      'The invoice service returned an unsupported document.',
    );
  const identity = [
    scope.operatorId,
    scope.storeId,
    scope.orderId,
    scope.kind,
    ...(scope.access ? [scope.access] : []),
  ].join(':');
  return html.replace(
    marker,
    marker +
      `<meta name="pos-invoice-scope" content="${identity}"><meta name="pos-invoice-number" content="${attribute(number ?? '')}">`,
  );
}
export const invoicePreviewPolicy =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-modals";
