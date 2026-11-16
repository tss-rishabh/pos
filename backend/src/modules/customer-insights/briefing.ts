import { createHmac } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { customerCheckoutScope, missingCustomerProfile } from './checkout-scope.js';
import { customerProfileScope, type CustomerProfileScope } from './contracts.js';
import { customerBriefingResponse, type BriefingIdentity } from './briefing-contracts.js';
import type { CustomerBriefingGateway } from './briefing-gateway.js';

export function customerBriefingService(
  config: Config,
  db: Databases,
  gateway: CustomerBriefingGateway,
) {
  const withCheckout = customerCheckoutScope(config, db);
  function binding(identity: BriefingIdentity): string {
    return createHmac('sha256', config.SESSION_SECRET)
      .update(JSON.stringify(identity))
      .digest('hex');
  }
  async function capture(user: Principal, scope: CustomerProfileScope) {
    return withCheckout(user, scope, 'share', async (tx, state) => {
      const [row] = await tx
        .select({ id: MUser.id, email: MUser.email, telephone: MUser.telephone })
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
      if (!row) throw missingCustomerProfile();
      const identity = { id: row.id.toString(), email: row.email, telephone: row.telephone };
      return { identity, checkoutVersion: state.version, binding: binding(identity) };
    });
  }
  return {
    async read(user: Principal, scope: CustomerProfileScope) {
      customerProfileScope.parse(scope);
      const original = await capture(user, scope);
      // No operator/customer/checkout SQL lock is held over network I/O.
      const briefing = await gateway.read(original.identity, scope.storeId);
      const current = await capture(user, scope);
      if (
        current.checkoutVersion !== original.checkoutVersion ||
        current.binding !== original.binding
      )
        throw new AppError(
          409,
          'CUSTOMER_INSIGHTS_CONTEXT_CHANGED',
          'This sale changed. Reopen customer insights.',
        );
      return customerBriefingResponse.parse({
        customerId: current.identity.id,
        checkoutVersion: current.checkoutVersion,
        briefing,
        fetchedAt: new Date().toISOString(),
      });
    },
  };
}
