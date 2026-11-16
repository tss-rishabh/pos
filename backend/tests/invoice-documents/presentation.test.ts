import { expect, it } from 'vitest';
import { sanitizeInvoiceHtml } from '../../src/modules/checkout/invoices.js';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../src/modules/invoice-documents/presentation.js';
it('binds the independently styled inert preview to its captured actor/store/order/kind and escapes the number', () => {
  const html = invoicePreviewHtml(
    sanitizeInvoiceHtml('<h1>Fixture</h1><script>BAD</script>'),
    { operatorId: '7', storeId: '1', orderId: '9007199254740993', kind: 'store' },
    'FIXTURE"><img src=x>',
  );
  expect(html).toContain('<meta name="pos-invoice-scope" content="7:1:9007199254740993:store">');
  expect(html).toContain('content="FIXTURE&quot;&gt;&lt;img src=x&gt;"');
  expect(html).not.toContain('<script');
  expect(invoicePreviewPolicy).toContain("script-src 'none'");
  expect(invoicePreviewPolicy).toContain("style-src 'unsafe-inline'");
  expect(invoicePreviewPolicy).toContain("frame-ancestors 'self'");
});
it('cannot stamp a provider document which bypassed the sanitizer', () => {
  expect(() =>
    invoicePreviewHtml(
      '<html><script>bad</script></html>',
      { operatorId: '7', storeId: '1', orderId: '3', kind: 'online' },
      null,
    ),
  ).toThrow('unsupported document');
});
