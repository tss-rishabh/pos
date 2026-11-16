import { describe, expect, it } from 'vitest';
import { sanitizeInvoiceHtml } from '../../src/modules/checkout/invoices.js';
describe('protected invoice document', () => {
  it('preserves authoritative invoice text and tables while removing scripts, navigation and external loads', () => {
    const html = sanitizeInvoiceHtml(
      '<html><body><h1>Invoice FST12627INV00001</h1><table><tr><th>GST</th><td>18.00</td></tr></table><script>stealCookies()</script><img src="https://attacker.test/leak" onerror="stealCookies()"><form action="https://attacker.test"><input name="token"></form><a href="javascript:alert(1)">Terms</a><iframe src="https://attacker.test"></iframe></body></html>',
    );
    expect(html).toContain('Invoice FST12627INV00001');
    expect(html).toContain('<td>18.00</td>');
    expect(html).not.toContain('attacker.test');
    expect(html).not.toContain('stealCookies');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<iframe');
    expect(html).toContain("script-src 'none'");
  });
  it('allows embedded raster invoice QR codes and rejects executable image formats', () => {
    const html = sanitizeInvoiceHtml(
      '<img src="data:image/png;base64,AAAA" width="120"><img src="data:image/svg+xml;base64,AAAA" onload="alert(1)"><img src="data:text/html;base64,AAAA">',
    );
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).not.toContain('svg+xml');
    expect(html).not.toContain('text/html;base64');
    expect(html).not.toContain('onload');
  });
});
