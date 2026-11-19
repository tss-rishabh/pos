import { describe, expect, it } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import type { CheckoutState } from '../../src/modules/checkout/contracts.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';

function sale(): CheckoutState {
  return {
    id: crypto.randomUUID(),
    draftId: crypto.randomUUID(),
    draftVersion: 0,
    operatorId: '44',
    operatorCustomerId: '777',
    storeId: '1',
    counterId: '3',
    tabId: 9,
    customerId: '1001',
    verifiedCustomerUntil: null,
    verificationChallenge: null,
    version: 0,
    phase: 'open',
    cart: null,
    quote: null,
    orderId: null,
    orderSubmissionOperationId: null,
    paymentConfirmation: null,
    salespersonId: null,
    lineSalespersons: {},
    giftCards: { '8001': { number: '990111', startDate: '', endDate: '' } },
    busyOperationId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('Redis checkout leases follow the stored sale', () => {
  it('releases a detached customer and dropped cards even when the clear spans checkpoints', async () => {
    const sessions = checkoutSessionStore(memoryStateStore()),
      repository = checkoutRepository({} as Databases, sessions),
      state = sale(),
      operationId = crypto.randomUUID();
    await sessions.write({ ...state, busyOperationId: operationId });
    await sessions.acquireLease('customer', '1001', state.id);
    await sessions.acquireLease('gift-card', '990111', state.id);
    // First checkpoint already lost the card (cart pruned); the second detaches and clears.
    await repository.checkpoint({ ...state, giftCards: {} }, operationId);
    await repository.checkpoint(
      { ...state, giftCards: {}, customerId: null, phase: 'cleared' },
      operationId,
    );
    expect(await sessions.leaseHolder('gift-card', '990111')).toBeNull();
    expect(await sessions.leaseHolder('customer', '1001')).toBeNull();
  });
  it('keeps a serial held when it moves to a replacement gift item', async () => {
    const sessions = checkoutSessionStore(memoryStateStore()),
      repository = checkoutRepository({} as Databases, sessions),
      state = sale(),
      operationId = crypto.randomUUID();
    await sessions.write({ ...state, busyOperationId: operationId });
    await sessions.acquireLease('gift-card', '990111', state.id);
    await repository.checkpoint({ ...state, giftCards: {} }, operationId);
    await repository.checkpoint(
      { ...state, giftCards: { '8002': { number: '990111', startDate: '', endDate: '' } } },
      operationId,
    );
    expect(await sessions.leaseHolder('gift-card', '990111')).toBe(state.id);
  });
});
