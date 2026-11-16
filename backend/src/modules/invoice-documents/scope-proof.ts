import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { InvoiceProofScope } from '../checkout/invoice-security.js';
import type { InvoiceSnapshot } from './authority.js';
import { invoiceIdentifier } from './contracts.js';

export const scopedInvoiceContract = 'pos-scoped-invoice-v1';
export const scopedInvoiceCapability = z
  .object({
    v: z.literal(1),
    purpose: z.literal('scoped-invoice'),
    contract: z.literal(scopedInvoiceContract),
    kind: z.enum(['same-day', 'express']),
    orderId: invoiceIdentifier,
    operatorId: invoiceIdentifier,
    storeId: invoiceIdentifier,
    customerId: invoiceIdentifier,
    nativeSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
    selection: z.enum(['source-is-sdd-shipment-0', 'store-express-line-items-v1']),
    selectedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    selectedCount: z.number().int().min(0).max(10000),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    issuedAt: z.number().int().safe(),
    expiresAt: z.number().int().safe(),
  })
  .strict();
export function selectedInvoiceHash(ids: readonly string[]) {
  return createHash('sha256').update(JSON.stringify(ids), 'utf8').digest('hex');
}
export function issueScopedInvoiceProof(
  kind: 'same-day' | 'express',
  scope: InvoiceProofScope,
  storeId: string,
  snapshot: InvoiceSnapshot,
  selected: readonly string[],
  key: string,
  now = Date.now(),
) {
  const payload = scopedInvoiceCapability.parse({
    v: 1,
    purpose: 'scoped-invoice',
    contract: scopedInvoiceContract,
    kind,
    orderId: scope.orderId,
    operatorId: scope.operatorId,
    storeId,
    customerId: snapshot.customerId,
    nativeSnapshot: snapshot.binding,
    selection: kind === 'express' ? 'store-express-line-items-v1' : 'source-is-sdd-shipment-0',
    selectedHash: kind === 'express' ? selectedInvoiceHash(selected) : null,
    selectedCount: selected.length,
    nonce: scope.nonce,
    requestId: scope.requestId,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 30,
  });
  const message =
    scopedInvoiceContract +
    '.' +
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return message + '.' + createHmac('sha256', key).update(message).digest('base64url');
}
export function scopedInvoiceResponseProof(capability: string, html: string, key: string) {
  return createHmac('sha256', key)
    .update(
      [
        scopedInvoiceContract,
        createHash('sha256').update(capability).digest('hex'),
        createHash('sha256').update(html, 'utf8').digest('hex'),
      ].join('\n'),
    )
    .digest('hex');
}
export function assertScopedInvoiceResponse(
  response: Response,
  capability: string,
  html: string,
  key: string,
) {
  const actual = response.headers.get('x-pos-invoice-scope-proof') ?? '',
    expected = scopedInvoiceResponseProof(capability, html, key);
  if (
    response.headers.get('x-pos-invoice-scope-contract') !== scopedInvoiceContract ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  )
    throw new AppError(
      502,
      'INVOICE_SCOPE_PROOF_UNCONFIRMED',
      'The invoice document scope could not be verified.',
    );
}
