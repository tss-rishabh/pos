import type { Checkout } from '../../src/pages/checkout/client';
export function fixtureCheckout(owner: string, version = 1) {
  const value: unknown = {
    id:
      owner === '1'
        ? '33333333-3333-4333-8333-333333333333'
        : '44444444-4444-4444-8444-444444444444',
    operatorId: owner,
    storeId: '1',
    counterId: '1',
    draftId: '11111111-1111-4111-8111-111111111111',
    draftVersion: 1,
    draftImport: { lineItems: [], completedProductIds: [], status: 'complete' },
    version,
    customerId: '7',
    salespersonId: null,
    lineSalespersons: {},
    settlementNote: null,
    verifiedCustomerUntil: Date.now() + 900000,
    verificationChallenge: {
      id: '55555555-5555-4555-8555-555555555555',
      expiresAt: Date.now() + 300000,
      attempts: 0,
      sent: true,
      lastSentAt: Date.now(),
    },
    phase: 'open',
    orderId: null,
    orderSubmissionOperationId: null,
    confirmationPhase: null,
    busyOperationId: null,
    giftCards: {},
    cart: { products: { items: [] }, meta: { items: [] } },
    quote: null,
    settlement: null,
  };
  // The page client validates every server reply; this is only the harness's initial state.
  return value as Checkout;
}
