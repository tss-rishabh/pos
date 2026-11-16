import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
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
export type FulfillmentAction = 'ACCEPT' | 'REJECT' | 'PACK' | 'PACK_LINE' | 'SHIP' | 'RTO';

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
}
export const actionStates: Record<
  FulfillmentAction,
  { from: readonly ExpressStatus[]; to: ExpressStatus }
> = {
  ACCEPT: { from: ['PENDING'], to: 'ACCEPTED' },
  REJECT: { from: ['PENDING', 'ACCEPTED'], to: 'REJECTED' },
  PACK: { from: ['ACCEPTED'], to: 'PACKED' },
  PACK_LINE: { from: ['ACCEPTED'], to: 'PACKED' },
  SHIP: { from: ['PACKED'], to: 'OUT_FOR_DELIVERY' },
  RTO: { from: ['OUT_FOR_DELIVERY'], to: 'RTO' },
};
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
export function actionableLines(
  action: FulfillmentAction,
  lines: FulfillmentLine[],
  lineId?: string,
) {
  const state = actionStates[action];
  const selected = lines.filter(
    (line) =>
      state.from.includes(line.status as ExpressStatus) &&
      (action !== 'PACK_LINE' || line.id === lineId),
  );
  if (!selected.length && ['SHIP', 'RTO', 'PACK_LINE'].includes(action)) {
    const message =
      action === 'SHIP'
        ? 'No packed items found'
        : action === 'RTO'
          ? 'No out-for-delivery items found for RTO'
          : 'Line item not found or not in ACCEPTED state';
    throw new AppError(409, 'FULFILLMENT_STATE_CONFLICT', message);
  }
  if (
    action === 'RTO' &&
    (selected.some((line) => line.productStatus !== 'RTO_DELIVERED') ||
      new Set(selected.map((line) => line.hasProductId)).size !== selected.length)
  ) {
    throw new AppError(409, 'RTO_NOT_RECEIVED', 'Not all items are in RTO_DELIVERED status');
  }
  return selected;
}

export interface FulfillmentEffect {
  kind:
    | 'concurrency-sync'
    | 'status-api'
    | 'rejection-api'
    | 'out-for-delivery-api'
    | 'rto-api'
    | 'store-notification';
  payload: Record<string, string | number | boolean | string[]>;
}
/** Pure effect plan. Delivery occurs after commit through a durable outbox. */
export function planEffects(
  action: FulfillmentAction,
  orderId: string,
  storeId: string,
  lines: FulfillmentLine[],
  reasonId?: string,
): FulfillmentEffect[] {
  if (!lines.length) return [];
  const hasProductIds = lines.map((line) => line.hasProductId);
  const effects: FulfillmentEffect[] = [];
  if (action === 'ACCEPT')
    effects.push({
      kind: 'concurrency-sync',
      payload: { storeId, pending: -lines.length, accepted: lines.length },
    });
  if (action === 'PACK' || action === 'SHIP')
    effects.push({
      kind: 'status-api',
      payload: {
        orderId,
        storeId,
        hasProductIds,
        status: action === 'PACK' ? 'PACK' : 'SHIP',
        isHyperlocal: true,
      },
    });
  if (action === 'PACK' || action === 'PACK_LINE')
    effects.push({
      kind: 'concurrency-sync',
      payload: { storeId, pending: 0, accepted: -lines.length },
    });
  if (action === 'REJECT')
    effects.push({
      kind: 'rejection-api',
      payload: { orderId, storeId, hasProductIds, rejectionReasonId: reasonId || '' },
    });
  if (action === 'SHIP')
    effects.push({
      kind: 'out-for-delivery-api',
      payload: { orderId, storeId, awb: lines[0]?.awb || '' },
    });
  if (action === 'RTO')
    effects.push({ kind: 'rto-api', payload: { orderId, storeId, hasProductIds } });
  if (action !== 'PACK_LINE')
    effects.push({
      kind: 'store-notification',
      payload: {
        action,
        orderId,
        storeId,
        productIds: lines.flatMap((line) => (line.productId ? [line.productId] : [])),
        commonChannel: action === 'RTO' || action === 'REJECT',
        ...(action === 'REJECT' ? { rejectionReasonId: reasonId || '' } : {}),
      },
    });
  return effects;
}
