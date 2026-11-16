import { shippingLabelDocument } from '../../src/modules/fulfillment/shipping-label/document.js';
process.stdout.write(
  shippingLabelDocument({
    orderId: '1001',
    storeId: '1',
    orderReference: 'FIXTURE-1001',
    orderDate: '2026-11-16 10:00:00',
    storeAddress: 'Fixture return road  Annex  0000000000',
    shippingAddress: {
      name: 'Fixture <script>unsafe()</script>',
      addressLine: '3B, Fixture road',
      cityLine: 'Fixture city - 000001, Fixture zone, Fixture country',
      phone: '0000000000',
    },
    paymentMode: 'Prepaid',
    product: 'Cloths',
    totalQuantity: '5',
    awb: 'AWB123456789012IN',
    dimensionsCm: ['30.000', '30.000', '2.000'],
    weightKg: '0.384',
  }).html,
);
