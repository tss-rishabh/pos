import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { inboundPayload } from '../../src/modules/checkout/return-workflow/gateway.js';
import { exchangePayload } from '../../src/modules/checkout/payloads.js';
const oracle = (operation: string): unknown =>
  JSON.parse(
    execFileSync('python3', ['tools/checkout/legacy_oracle.py'], {
      input: JSON.stringify({ operation }),
      encoding: 'utf8',
    }),
  ) as unknown;
describe('source-extracted return and exchange payload parity', () => {
  it('preserves the warehouse request fields and exchange Replacement category', () => {
    const input = {
      locationCode: 'FST1',
      orderId: '9001',
      trackingNumber: 9001,
      returnDate: '16/11/2026 12:00:00',
      customerName: 'Fixture',
      address1: 'Fixture address',
      address2: '',
      state: '19',
      city: 'Fixture city',
      pincode: '400001',
      remarks: 'Size issue:Fixture',
      productId: '10',
      lineId: '9101',
      quantity: 2,
      reason: 'Size issue',
    };
    expect(
      [false, true].map((exchange) =>
        inboundPayload({ ...input, exchange }, 'fixture-transporter'),
      ),
    ).toEqual(oracle('inbound_payloads'));
  });
  it('preserves the exact source pos/exchange child-order payload', () => {
    expect(
      exchangePayload({
        orderId: '9001',
        lineId: '9101',
        oldProductId: '10',
        newProductId: '11',
        parentId: '100',
        size: 'L',
        storeId: '1',
        counterId: '3',
        saleable: false,
        reasonId: '1',
        subReasonId: null,
        comment: 'Fixture',
        adminCustomerId: '777',
        salespersonId: '5',
      }),
    ).toEqual(oracle('exchange_payload'));
  });
});
