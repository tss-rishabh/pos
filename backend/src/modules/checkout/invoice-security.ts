import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { feedbackProofContract } from './feedback-proof.js';
export { feedbackProofContract } from './feedback-proof.js';

export const invoiceSecurityContract = 'pos-invoice-security-v1';
const scopeSchema = z.object({
  kind: z.enum(['store', 'online', 'same-day']),
  orderId: identifier,
  operatorId: identifier,
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
});
export type InvoiceProofScope = z.infer<typeof scopeSchema>;

/** Shared byte-for-byte with the private source provider; no JSON reserialization. */
export function invoiceResponseProof(scope: InvoiceProofScope, source: string, key: string) {
  const checked = scopeSchema.parse(scope);
  if (Buffer.byteLength(key, 'utf8') < 32)
    throw new AppError(503, 'INVOICE_SECURITY_UNCONFIRMED', 'Invoice security is not configured.');
  const message = [
    invoiceSecurityContract,
    feedbackProofContract,
    checked.kind,
    checked.orderId,
    checked.operatorId,
    checked.requestId,
    checked.nonce,
    createHash('sha256').update(source, 'utf8').digest('hex'),
  ].join('\n');
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}
export function assertInvoiceResponseProof(
  response: Response,
  scope: InvoiceProofScope,
  source: string,
  key: string,
) {
  const actual = response.headers.get('x-pos-invoice-proof') ?? '';
  if (
    response.headers.get('x-pos-invoice-contract') !== invoiceSecurityContract ||
    response.headers.get('x-pos-feedback-contract') !== feedbackProofContract ||
    response.headers.get('x-pos-invoice-nonce') !== scope.nonce ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    !timingSafeEqual(
      Buffer.from(actual, 'hex'),
      Buffer.from(invoiceResponseProof(scope, source, key), 'hex'),
    )
  )
    throw new AppError(
      502,
      'INVOICE_SECURITY_UNCONFIRMED',
      'The invoice security contract could not be verified.',
    );
}
