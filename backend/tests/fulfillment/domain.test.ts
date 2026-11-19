import { describe, expect, it } from 'vitest';
import {
  fulfillmentOrderFacts,
  type FulfillmentLine,
} from '../../src/modules/fulfillment/domain.js';
import { expiryTransitions } from '../../src/modules/fulfillment/expiry.js';
import { goldenStdout } from '../golden/load.js';

type OracleLine = Omit<FulfillmentLine, 'price' | 'image' | 'parentProductId'>;
/** Card-only fields are not part of the captured oracle input, so they are added per call. */
const card = (lines: OracleLine[]): FulfillmentLine[] =>
  lines.map((item) => ({ ...item, price: null, image: null, parentProductId: null }));
function line(change: Partial<OracleLine> = {}): OracleLine {
  return {
    id: '1',
    orderId: '1',
    storeId: '1',
    hasProductId: '11',
    status: 'PENDING',
    pendingExpiresAt: '2026-11-16 12:00:00',
    acceptedExpiresAt: null,
    productId: '101',
    productName: 'Fixture',
    productStatus: 'DELIVERED',
    quantity: '3',
    preGstAmount: 99.99,
    gst: 5,
    awb: '',
    shipmentId: '',
    vincStatus: '',
    ...change,
  };
}
describe('express fulfillment source parity', () => {
  it('matches original card facts, including duplicate HP allocation sets and split shipment flags', () => {
    const cases = [
      [line()],
      [line({ status: 'RTO', productStatus: 'RTO_DELIVERED' })],
      [line({ status: 'OUT_FOR_DELIVERY', productStatus: 'RTO_DELIVERED' })],
      [line({ status: 'TIMED_OUT' })],
      [line({ vincStatus: 'Allocated' }), line({ id: '2', vincStatus: 'not-allocated' })],
      [line({ shipmentId: '100' }), line({ id: '2', hasProductId: '12', awb: 'AWB' })],
      [line({ productId: null, preGstAmount: null, gst: null })],
    ];
    for (let i = 0; i < 20; i++)
      cases.push([
        line({
          preGstAmount: i * 2.675,
          gst: i % 2 ? 5 : 12,
          vincStatus: i % 3 ? 'Part Allocated' : '',
          status: i % 2 ? 'RTO' : 'PENDING',
        }),
      ]);
    const expected: unknown = JSON.parse(
      goldenStdout('fulfillment', 'domain.oracle', JSON.stringify({ cases })),
    );
    expect(
      cases.map((lines) => {
        const r = fulfillmentOrderFacts(card(lines));
        return {
          store_order_amt: r.storeOrderAmount,
          is_rto: r.isRto,
          can_mark_rto: r.canMarkRto,
          is_timed_out: r.isTimedOut,
          is_vinc_allocated: r.isVincAllocated,
          has_shipment_id: r.hasShipmentId,
          has_awb: r.hasAwb,
        };
      }),
    ).toEqual(expected);
  });
  it('matches the original pending timeout/allocation split and accepted auto-pack helpers', () => {
    const cases = [];
    for (let mask = 0; mask < 16; mask++) {
      const lines = Array.from({ length: 4 }, (_, i) =>
        line({
          id: String(i + 1),
          orderId: String(i < 2 ? 1 : 2),
          hasProductId: String(i + 10),
          vincStatus: mask & (1 << i) ? 'Allocated' : '',
        }),
      );
      cases.push(
        { phase: 'pending-expiry' as const, lines },
        {
          phase: 'accepted-expiry' as const,
          lines: lines.map((line) => ({ ...line, status: 'ACCEPTED' })),
        },
      );
    }
    const oracle: unknown = JSON.parse(
      goldenStdout('fulfillment', 'domain.maintenance-oracle', JSON.stringify({ cases })),
    );
    expect(
      cases.map((test) =>
        expiryTransitions(test.phase, test.lines, ['Allocated', 'Part Allocated']).map(
          (transition) => ({
            orderId: transition.orderId,
            from: transition.from,
            to: transition.to,
            ids: transition.lines.map((line) => line.id).sort(),
          }),
        ),
      ),
    ).toEqual(oracle);
    expect(
      expiryTransitions(
        'allocation-retry',
        [line({ status: 'TIMED_OUT', vincStatus: '' })],
        ['Allocated'],
      ),
    ).toEqual([]);
    expect(
      expiryTransitions(
        'allocation-retry',
        [line({ status: 'TIMED_OUT', vincStatus: 'Allocated' })],
        ['Allocated'],
      )[0]?.to,
    ).toBe('REJECTED');
  });
});
