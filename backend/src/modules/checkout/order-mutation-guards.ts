import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  assertNoActiveWholeOrderHandover,
  type AssertHandoverAvailable,
} from '../legacy-order-status/handover.js';
import { assertNoPendingCashReturnForOrders } from './payment-reversals/intent-guards.js';

/** Callers hold current Store→Order locks before crossing either financial boundary. */
export function orderMutationGuards(keys: { cashReturnProofKey: string }) {
  const assertHandoverAvailable: AssertHandoverAvailable = async (tx, orderIds) => {
    await assertNoPendingCashReturnForOrders(tx, orderIds, keys.cashReturnProofKey);
  };
  async function assertCashReturnHandoverReady(tx: AdministrationTransaction, orderId: string) {
    await assertNoActiveWholeOrderHandover(tx, [orderId]);
  }
  return { assertHandoverAvailable, assertCashReturnHandoverReady };
}
