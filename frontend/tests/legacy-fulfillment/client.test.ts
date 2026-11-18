import { describe, expect, it } from 'vitest';
import {
  awaitingAcceptance,
  localDeliveryStatus,
  rtoOrder,
  type LocalDeliveryStatus,
} from '../../src/pages/legacy-fulfillment/client';

const base: LocalDeliveryStatus = {
  orderId: '1001',
  storeId: '1',
  split: false,
  orderStatusId: '1',
  paymentStatusId: '4',
  transferred: false,
  nextStoreIds: ['2'],
  eligibleStoreIds: ['1'],
  childOrderId: null,
  courier: null,
  check: { status: '400', message: 'Failed', error: 'Order not created' },
};
const courier = (action: NonNullable<LocalDeliveryStatus['courier']>['action'], extra = {}) => ({
  action,
  courierOrderId: null,
  created: false,
  packed: false,
  rto: false,
  rtoReceived: false,
  refunded: false,
  sourceTrackingUrl: null,
  destinationTrackingUrl: null,
  ...extra,
});

describe('local delivery action guards (legacy online order template)', () => {
  it('offers accept/pass only for a paid, placed order without a terminal courier action', () => {
    expect(awaitingAcceptance(base)).toBe(true);
    expect(awaitingAcceptance({ ...base, courier: courier('NO_ACTION') })).toBe(true);
    expect(awaitingAcceptance({ ...base, courier: courier('ACCEPTED') })).toBe(false);
    expect(awaitingAcceptance({ ...base, paymentStatusId: '1' })).toBe(false);
    expect(awaitingAcceptance({ ...base, orderStatusId: '21' })).toBe(false);
    expect(awaitingAcceptance({ ...base, orderStatusId: '21', split: true })).toBe(true);
  });
  it('treats order status 28/29 or is_rto as an RTO order', () => {
    expect(rtoOrder(base)).toBe(false);
    expect(rtoOrder({ ...base, orderStatusId: '28' })).toBe(true);
    expect(rtoOrder({ ...base, courier: courier('ACCEPTED', { rto: true }) })).toBe(true);
  });
  it('rejects unexpected status fields', () => {
    expect(localDeliveryStatus.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
