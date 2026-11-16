import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  shippingLabelCsp,
  shippingLabelDocument,
  sourceShippingDate,
} from '../../src/modules/fulfillment/shipping-label/document.js';
import type { ShippingLabel } from '../../src/modules/fulfillment/shipping-label/contracts.js';

const fixture: ShippingLabel = {
  orderId: '9007199254740993',
  storeId: '1',
  orderReference: 'FIXTURE-1',
  orderDate: '2026-11-16 09:35:00',
  storeAddress: 'Fixture store  Annex  0000',
  shippingAddress: {
    name: 'Fixture Recipient',
    addressLine: '3B, Fixture road',
    cityLine: 'Fixture city - 000001, State, Country',
    phone: '0000000000',
  },
  paymentMode: 'Prepaid',
  product: 'Cloths',
  totalQuantity: '3',
  awb: 'AWB123456789012IN',
  dimensionsCm: ['30.000', '30.000', '2.000'],
  weightKg: '0.384',
};
describe('private standalone shipping document', () => {
  it('retains source label fields, real barcodes and100×150mm printing without active content or external resources', () => {
    const { html, filename } = shippingLabelDocument(fixture);
    expect(filename).toBe('shipping-label-9007199254740993-1.html');
    for (const text of [
      'Payment Mode : Prepaid',
      'NIL',
      'SHIP TO :-',
      'FROM/RETURN :-',
      'If undelivered, please return to:',
      'Order Date : Nov. 16, 2026',
      'Invoice # : FIXTURE-1',
      'Order No: 9007199254740993',
      '30.000 *30.000 *2.000',
      '0.384',
      'Cloths',
      'Prices are inclusive of all applicable taxes',
      'size:100mm 150mm',
    ])
      expect(html).toContain(text);
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).toContain('name="pos-shipping-label" content="1:9007199254740993"');
    expect(html).not.toMatch(/<(script|iframe|img|link)\b|\bon[a-z]+=|\bsrc=/i);
    const style = /<style>([^]*?)<\/style>/.exec(html)?.[1];
    expect(style).toBeTruthy();
    expect(shippingLabelCsp).toContain(
      `style-src 'sha256-${createHash('sha256').update(style!).digest('base64')}'`,
    );
    expect(shippingLabelCsp).toContain("script-src 'none'");
    expect(shippingLabelCsp).toContain("frame-ancestors 'self'");
  });
  it('escapes every human field and preserves the source missing-address fallback', () => {
    const html = shippingLabelDocument({
      ...fixture,
      orderReference: '<script>bad()</script>',
      storeAddress: '" onload="bad()',
      shippingAddress: {
        name: '<img src=x onerror=bad()>',
        addressLine: '<&>',
        cityLine: 'test',
        phone: '0000',
      },
    }).html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=bad()&gt;');
    expect(html).toContain('&quot; onload=&quot;bad()');
    expect(
      shippingLabelDocument({ ...fixture, shippingAddress: null, orderDate: null, awb: '0' }).html,
    ).toContain('Address not available');
    expect(sourceShippingDate(null)).toBe('');
    expect(sourceShippingDate('2026-09-01 00:00:00')).toBe('Sept. 1, 2026');
    expect(() => sourceShippingDate('0000-00-00 00:00:00')).toThrow('requires reconciliation');
  });
});
