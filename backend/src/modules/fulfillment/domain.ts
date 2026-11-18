import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { pythonRound2 } from '../../domain/python-round.js';

export const expressStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'PACKED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'RTO',
  'TIMED_OUT',
]);
export type ExpressStatus = z.infer<typeof expressStatusSchema>;
export const fulfillmentTabSchema = z.enum(['in_queue', 'not_packed', 'packed', 'shipped']);
export type FulfillmentTab = z.infer<typeof fulfillmentTabSchema>;

export interface FulfillmentLine {
  id: string;
  orderId: string;
  storeId: string;
  hasProductId: string;
  status: string | null;
  pendingExpiresAt: string | null;
  acceptedExpiresAt: string | null;
  productId: string | null;
  productName: string | null;
  productStatus: string | null;
  quantity: string | null;
  preGstAmount: number | null;
  gst: number | null;
  awb: string | null;
  shipmentId: string | null;
  vincStatus: string;
  price: string | null;
  image: string | null;
  parentProductId: string | null;
}
export const tabStatuses: Record<FulfillmentTab, readonly ExpressStatus[]> = {
  in_queue: ['PENDING'],
  not_packed: ['ACCEPTED'],
  packed: ['PACKED'],
  shipped: ['OUT_FOR_DELIVERY', 'DELIVERED', 'RTO'],
};

export function localTimestamp(instant: Temporal.Instant, zone: string): string {
  return instant
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
}
export function calendarBounds(instant: Temporal.Instant, zone: string) {
  const today = instant.toZonedDateTimeISO(zone).startOfDay();
  return {
    start: localTimestamp(today.toInstant(), zone),
    end: localTimestamp(today.add({ days: 1 }).toInstant(), zone),
  };
}
/** Source: order/views.py:_hl_get_orders_for_tab. Keep legacy float + round semantics. */
export function fulfillmentOrderFacts(lines: FulfillmentLine[]) {
  const allocated = new Set(['Allocated', 'Part Allocated']);
  const productIds = new Set(lines.map((line) => line.hasProductId));
  const allocatedProductIds = new Set(
    lines.filter((line) => allocated.has(line.vincStatus)).map((line) => line.hasProductId),
  );
  const productLines = lines.filter((line) => line.productId !== null);
  const hasShipmentId = productLines.some((line) =>
    Boolean(line.shipmentId && line.shipmentId !== '0'),
  );
  return {
    storeOrderAmount: pythonRound2(
      productLines.reduce(
        (sum, line) => sum + (line.preGstAmount || 0) * (1 + (line.gst || 0) / 100),
        0,
      ),
    ),
    isRto:
      lines.length > 0 &&
      lines.every((line) => line.status === 'RTO' && line.productStatus === 'RTO_DELIVERED'),
    canMarkRto:
      lines.length > 0 &&
      lines.every(
        (line) => line.status === 'OUT_FOR_DELIVERY' && line.productStatus === 'RTO_DELIVERED',
      ),
    isTimedOut: lines.length > 0 && lines.every((line) => line.status === 'TIMED_OUT'),
    isVincAllocated:
      productIds.size > 0 && [...productIds].every((id) => allocatedProductIds.has(id)),
    hasShipmentId,
    hasAwb: hasShipmentId && productLines.some((line) => Boolean(line.awb && line.awb !== '0')),
  };
}
