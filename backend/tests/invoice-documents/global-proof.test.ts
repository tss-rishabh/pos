import { describe, expect, it } from 'vitest';
import {
  globalOnlineInvoiceContract,
  globalOnlineInvoiceCapability,
  issueGlobalOnlineInvoiceProof,
  globalOnlineInvoiceResponseProof,
  assertGlobalOnlineInvoiceResponse,
} from '../../src/modules/invoice-documents/global-proof.js';
import { invoiceDocumentScope } from '../../src/modules/invoice-documents/contracts.js';
import { invoicePreviewHtml } from '../../src/modules/invoice-documents/presentation.js';
const scope = {
  kind: 'online' as const,
  orderId: '9007199254740993',
  operatorId: '7',
  requestId: 'fixture-global-invoice',
  nonce: 'a'.repeat(32),
};
const authority = {
  binding: 'b'.repeat(64),
  customerId: '9007199254740994',
  number: null,
  orderStatus: '3',
  updatedAt: '2026-11-18 10:00:00',
  globalOnline: { actorBinding: 'c'.repeat(64), role: 4 },
};
const key = 'global-invoice-fixture-key-'.repeat(3);
describe('explicit global invoice issuer and authority proof', () => {
  it('separates context from owner and binds history, actor, source selection and exact IDs', () => {
    const proof = issueGlobalOnlineInvoiceProof(
      'online',
      scope,
      '1',
      authority,
      'fixture-history',
      key,
    );
    const value = globalOnlineInvoiceCapability.parse(
      JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString()) as unknown,
    );
    expect(value).toMatchObject({
      contextStoreId: '1',
      ownerStoreId: null,
      orderId: scope.orderId,
      customerId: authority.customerId,
      issuerPolicy: 'pinned-online-renderer',
      selection: 'full-order',
      userType: 1,
    });
    expect(proof.startsWith(globalOnlineInvoiceContract + '.')).toBe(true);
    for (const changed of [
      { ...authority, globalOnline: undefined },
      { ...authority, globalOnline: { actorBinding: 'bad', role: 4 } },
    ])
      expect(() =>
        issueGlobalOnlineInvoiceProof('online', scope, '1', changed, 'fixture-history', key),
      ).toThrow();
    const html = '<html><body>Fixture</body></html>',
      response = new Response(html, {
        headers: {
          'X-POS-Global-Invoice-Contract': globalOnlineInvoiceContract,
          'X-POS-Global-Invoice-Proof': globalOnlineInvoiceResponseProof(proof, html, key),
        },
      });
    expect(() => assertGlobalOnlineInvoiceResponse(response, proof, html, key)).not.toThrow();
    expect(() =>
      assertGlobalOnlineInvoiceResponse(response, proof, html + 'changed', key),
    ).toThrow();
    expect(() =>
      assertGlobalOnlineInvoiceResponse(response, proof + 'changed', html, key),
    ).toThrow();
  });
  it('requires literal access and separates protected frame identities without changing owned defaults', () => {
    expect(invoiceDocumentScope.parse({ storeId: '1', orderId: scope.orderId })).not.toHaveProperty(
      'access',
    );
    expect(() =>
      invoiceDocumentScope.parse({ storeId: '1', orderId: scope.orderId, access: 'all' }),
    ).toThrow();
    const html = '<html><head><meta name="pos-invoice" content="sanitized"></head></html>';
    const base = { operatorId: '7', storeId: '1', orderId: scope.orderId, kind: 'online' as const };
    expect(invoicePreviewHtml(html, { ...base, access: 'global-online' }, null)).toContain(
      `7:1:${scope.orderId}:online:global-online`,
    );
    expect(invoicePreviewHtml(html, base, null)).not.toContain('global-online');
  });
});
