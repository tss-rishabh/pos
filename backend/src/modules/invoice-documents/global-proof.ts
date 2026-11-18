import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { InvoiceProofScope } from '../checkout/invoice-security.js';
import type { InvoiceAuthority } from './authority.js';
import { invoiceIdentifier } from './contracts.js';
export const globalOnlineInvoiceContract = 'pos-global-online-invoice-v1';
export const globalOnlineInvoiceCapability = z
  .object({
    v: z.literal(1),
    purpose: z.literal('global-online-invoice'),
    contract: z.literal(globalOnlineInvoiceContract),
    kind: z.enum(['online', 'same-day']),
    orderId: invoiceIdentifier,
    operatorId: invoiceIdentifier,
    contextStoreId: invoiceIdentifier,
    ownerStoreId: z.null(),
    customerId: invoiceIdentifier,
    role: z.number().int().min(1).max(5),
    userType: z.literal(1),
    issuerPolicy: z.enum(['pinned-online-renderer', 'source-sdd-renderer']),
    selection: z.enum(['full-order', 'source-is-sdd-shipment-0']),
    nativeSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
    actorSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
    historyProofHash: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    issuedAt: z.number().int().safe(),
    expiresAt: z.number().int().safe(),
  })
  .strict();
export function issueGlobalOnlineInvoiceProof(
  kind: 'online' | 'same-day',
  scope: InvoiceProofScope,
  contextStoreId: string,
  authority: InvoiceAuthority,
  historyProof: string,
  key: string,
  now = Date.now(),
) {
  if (!authority.globalOnline)
    throw new AppError(404, 'INVOICE_SCOPE_UNCONFIRMED', 'This global invoice is not authorized.');
  const value = globalOnlineInvoiceCapability.parse({
    v: 1,
    purpose: 'global-online-invoice',
    contract: globalOnlineInvoiceContract,
    kind,
    orderId: scope.orderId,
    operatorId: scope.operatorId,
    contextStoreId,
    ownerStoreId: null,
    customerId: authority.customerId,
    role: authority.globalOnline.role,
    userType: 1,
    issuerPolicy: kind === 'online' ? 'pinned-online-renderer' : 'source-sdd-renderer',
    selection: kind === 'online' ? 'full-order' : 'source-is-sdd-shipment-0',
    nativeSnapshot: authority.binding,
    actorSnapshot: authority.globalOnline.actorBinding,
    historyProofHash: createHash('sha256').update(historyProof).digest('hex'),
    nonce: scope.nonce,
    requestId: scope.requestId,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 30,
  });
  const body =
    globalOnlineInvoiceContract + '.' + Buffer.from(JSON.stringify(value)).toString('base64url');
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url');
}
export function globalOnlineInvoiceResponseProof(capability: string, html: string, key: string) {
  return createHmac('sha256', key)
    .update(
      [
        globalOnlineInvoiceContract,
        createHash('sha256').update(capability).digest('hex'),
        createHash('sha256').update(html).digest('hex'),
      ].join('\n'),
    )
    .digest('hex');
}
export function assertGlobalOnlineInvoiceResponse(
  response: Response,
  capability: string,
  html: string,
  key: string,
) {
  const actual = response.headers.get('x-pos-global-invoice-proof') || '',
    expected = globalOnlineInvoiceResponseProof(capability, html, key);
  if (
    response.headers.get('x-pos-global-invoice-contract') !== globalOnlineInvoiceContract ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  )
    throw new AppError(
      502,
      'INVOICE_GLOBAL_PROOF_UNCONFIRMED',
      'The global invoice authorization and issuer policy could not be verified.',
    );
}
export function sameInvoiceAuthority(left: InvoiceAuthority, right: InvoiceAuthority) {
  return (
    left.binding === right.binding &&
    left.globalOnline?.actorBinding === right.globalOnline?.actorBinding
  );
}
