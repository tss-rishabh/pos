import type { AdministrationTransaction } from '../administration/checkins.js';
import { assertImportOrderMutationAvailable } from '../legacy-order-imports/financial-adapter-proof.js';
import {
  assertNoActiveWholeOrderHandover,
  type AssertHandoverAvailable,
} from '../legacy-order-status/handover.js';
import { assertNoPendingCashReturnForOrders } from './payment-reversals/intent-guards.js';

/** Callers hold current Store→Order locks before crossing either financial boundary. */
export function orderMutationGuards(keys: { cashReturnProofKey: string; importProofKey: string }) {
  const assertHandoverAvailable: AssertHandoverAvailable = async (tx, orderIds) => {
    await assertNoPendingCashReturnForOrders(tx, orderIds, keys.cashReturnProofKey);
    for (const orderId of new Set(orderIds))
      await assertImportOrderMutationAvailable(tx, orderId, keys.importProofKey);
  };
  async function assertCashReturnHandoverReady(tx: AdministrationTransaction, orderId: string) {
    await assertNoActiveWholeOrderHandover(tx, [orderId]);
    await assertImportOrderMutationAvailable(tx, orderId, keys.importProofKey);
  }
  return { assertHandoverAvailable, assertCashReturnHandoverReady };
}
