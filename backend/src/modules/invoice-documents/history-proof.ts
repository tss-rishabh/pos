import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { InvoiceProofScope } from '../checkout/invoice-security.js';
import type { InvoiceAuthority } from './authority.js';
import { invoiceIdentifier } from './contracts.js';
import { invoiceHistoryEvidence, type InvoiceHistory } from './history.js';
export const invoiceHistoryContract = 'pos-online-invoice-history-v1';
export const invoiceHistoryCapability = z
  .object({
    v: z.literal(1),
    purpose: z.literal('online-invoice-history'),
    contract: z.literal(invoiceHistoryContract),
    orderId: invoiceIdentifier,
    operatorId: invoiceIdentifier,
    storeId: invoiceIdentifier,
    customerId: invoiceIdentifier,
    orderCount: z
      .string()
      .regex(/^(0|[1-9]\d{0,18})$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
    nativeSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    issuedAt: z.number().int().safe(),
    expiresAt: z.number().int().safe(),
    publication: invoiceHistoryEvidence,
  })
  .strict();
export function issueInvoiceHistoryProof(
  scope: InvoiceProofScope,
  storeId: string,
  authority: InvoiceAuthority,
  history: InvoiceHistory,
  key: string,
  now = Date.now(),
) {
  const payload = invoiceHistoryCapability.parse({
    v: 1,
    purpose: 'online-invoice-history',
    contract: invoiceHistoryContract,
    orderId: scope.orderId,
    operatorId: scope.operatorId,
    storeId,
    customerId: authority.customerId,
    orderCount: history.count,
    nativeSnapshot: authority.binding,
    nonce: scope.nonce,
    requestId: scope.requestId,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 30,
    publication: history.evidence,
  });
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
    message = invoiceHistoryContract + '.' + body;
  return message + '.' + createHmac('sha256', key).update(message).digest('base64url');
}
export function invoiceHistoryResponseProof(capability: string, html: string, key: string) {
  return createHmac('sha256', key)
    .update(
      [
        invoiceHistoryContract,
        createHash('sha256').update(capability).digest('hex'),
        createHash('sha256').update(html, 'utf8').digest('hex'),
      ].join('\n'),
    )
    .digest('hex');
}
export function assertInvoiceHistoryResponse(
  response: Response,
  capability: string,
  html: string,
  key: string,
) {
  const actual = response.headers.get('x-pos-invoice-history-proof') ?? '',
    expected = invoiceHistoryResponseProof(capability, html, key);
  if (
    response.headers.get('x-pos-invoice-history-contract') !== invoiceHistoryContract ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  )
    throw new AppError(
      502,
      'INVOICE_HISTORY_PROOF_UNCONFIRMED',
      'The invoice historical count could not be verified.',
    );
}
