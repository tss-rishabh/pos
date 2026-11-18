import { describe, expect, it } from 'vitest';
import {
  actionableLines,
  fulfillmentOrderFacts,
  planEffects,
  type FulfillmentLine,
} from '../../src/modules/fulfillment/domain.js';
import { expiryTransitions } from '../../src/modules/fulfillment/maintenance.js';
import { goldenStdout } from '../golden/load.js';

function line(change: Partial<FulfillmentLine> = {}): FulfillmentLine {
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
describe('express fulfillment source parity and lifecycle safety', () => {
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
        const r = fulfillmentOrderFacts(lines);
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
  it('only changes source-eligible statuses and requires RTO receipt for every selected line', () => {
    const rows = [
      line(),
      line({ id: '2', status: 'ACCEPTED' }),
      line({ id: '3', status: 'PACKED' }),
    ];
    expect(actionableLines('ACCEPT', rows).map((l) => l.id)).toEqual(['1']);
    expect(actionableLines('REJECT', rows).map((l) => l.id)).toEqual(['1', '2']);
    expect(actionableLines('PACK', rows).map((l) => l.id)).toEqual(['2']);
    expect(actionableLines('SHIP', rows).map((l) => l.id)).toEqual(['3']);
    expect(() =>
      actionableLines('RTO', [line({ status: 'OUT_FOR_DELIVERY', productStatus: 'DELIVERED' })]),
    ).toThrow('Not all items');
    expect(() => actionableLines('SHIP', [])).toThrow('No packed items');
    expect(() => actionableLines('PACK_LINE', rows, '1')).toThrow('ACCEPTED');
  });
  it('queues signed counter deltas and external effects instead of claiming upstream completion', () => {
    const accepted = planEffects('ACCEPT', '1', '1', [line(), line({ id: '2' })]);
    expect(accepted.find((e) => e.kind === 'concurrency-sync')?.payload).toEqual({
      storeId: '1',
      pending: -2,
      accepted: 2,
    });
    const packed = planEffects('PACK', '1', '1', [line({ status: 'ACCEPTED' })]);
    expect(packed.find((e) => e.kind === 'concurrency-sync')?.payload.accepted).toBe(-1);
    expect(packed.find((e) => e.kind === 'status-api')?.payload.status).toBe('PACK');
    expect(
      planEffects('PACK_LINE', '1', '1', [line({ status: 'ACCEPTED' })]).some(
        (e) => e.kind === 'status-api',
      ),
    ).toBe(false);
    expect(planEffects('ACCEPT', '1', '1', [])).toEqual([]);
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
