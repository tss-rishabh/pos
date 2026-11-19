import { describe, expect, it } from 'vitest';
import { inboundPayload } from '../../src/modules/checkout/return-workflow/gateway.js';

// W26: orders.zone_id is TEXT holding the state name on real orders; legacy forwards it as-is.
describe('Vinculum inbound customer_state', () => {
  const input = {
    locationCode: 'FST1',
    orderId: '19055009',
    trackingNumber: 19055009,
    returnDate: '20/11/2026 03:20:00',
    customerName: 'Fixture',
    address1: '',
    address2: '',
    city: 'Fixture city',
    pincode: '560038',
    remarks: 'Size issue:Fixture',
    productId: '262148',
    lineId: '79083094',
    quantity: 1,
    reason: 'Size issue',
  };
  it('forwards a state name unchanged', () => {
    const [entry] = inboundPayload(
      { ...input, state: 'Himachal Pradesh', exchange: false },
      '28',
    ).orderReturn;
    expect(entry!.customer_state).toBe('Himachal Pradesh');
  });
  it('keeps a numeric state numeric', () => {
    const [entry] = inboundPayload({ ...input, state: '19', exchange: false }, '28').orderReturn;
    expect(entry!.customer_state).toBe(19);
  });
});
