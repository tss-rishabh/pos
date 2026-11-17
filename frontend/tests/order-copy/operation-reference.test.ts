import { describe, expect, it } from 'vitest';
import { checkoutOperationReference } from '../../src/pages/checkout/operation-reference';
import { copyBindingSchema } from '../../src/pages/order-copy/client';

const copy = copyBindingSchema.parse({
  commandId: '11111111-1111-4111-8111-111111111111',
  reviewId: '22222222-2222-4222-8222-222222222222',
  originHash: 'a'.repeat(64),
  status: 'review-required',
  resultHash: 'b'.repeat(64),
});
const generic = '33333333-3333-4333-8333-333333333333';
describe('checkout recovery protocol selection', () => {
  it('keeps pending and acknowledged copy references out of generic operation recovery', () => {
    expect(
      checkoutOperationReference({ busyOperationId: copy.commandId, orderCopy: copy }),
    ).toBeNull();
    expect(
      checkoutOperationReference(
        { busyOperationId: null, orderCopy: { ...copy, status: 'acknowledged' } },
        copy.commandId,
      ),
    ).toBeNull();
  });
  it('retains a distinct current operation and original unknown generic recovery', () => {
    expect(
      checkoutOperationReference({ busyOperationId: generic, orderCopy: copy }, copy.commandId),
    ).toBe(generic);
    expect(checkoutOperationReference({ busyOperationId: null, orderCopy: copy }, generic)).toBe(
      generic,
    );
    expect(checkoutOperationReference({ busyOperationId: generic })).toBe(generic);
  });
});
