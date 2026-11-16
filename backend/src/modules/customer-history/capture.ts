import { createHmac } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import {
  customerCheckoutScope,
  missingCustomerProfile,
} from '../customer-insights/checkout-scope.js';
import type { CustomerProfileScope } from '../customer-insights/contracts.js';
import type { HistoryCapture } from './contracts.js';
export type HistoryCaptureFn = (
  user: Principal,
  scope: CustomerProfileScope,
) => Promise<HistoryCapture>;
export function historyCapture(config: Config, db: Databases): HistoryCaptureFn {
  const withCheckout = customerCheckoutScope(config, db);
  return (user, scope) =>
    withCheckout(user, scope, 'share', async (tx, state) => {
      const [customer] = await tx
        .select({ id: MUser.id, sourceNow: sql<string>`DATE_FORMAT(NOW(),'%Y-%m-%d %H:%i:%s')` })
        .from(MUser)
        .where(
          and(
            eq(MUser.id, BigInt(state.customerId)),
            eq(MUser.status, 1),
            or(isNull(MUser.is_block), eq(MUser.is_block, 0)),
          ),
        )
        .limit(1)
        .for('share');
      if (!customer) throw missingCustomerProfile();
      const binding = createHmac('sha256', config.SESSION_SECRET)
        .update(
          JSON.stringify([
            1,
            user.id,
            state.storeId,
            state.counterId,
            state.id,
            state.customerId,
            state.version,
          ]),
        )
        .digest('hex');
      return {
        customerId: String(customer.id),
        checkoutVersion: state.version,
        sourceNow: customer.sourceNow,
        binding,
      };
    });
}
