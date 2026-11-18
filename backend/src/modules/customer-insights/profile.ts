import { and, eq, isNull, or } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { customerProfileSchema, type CustomerProfileScope } from './contracts.js';
import {
  customerCheckoutScope,
  customerProfileEditable,
  missingCustomerProfile,
} from './checkout-scope.js';
import {
  customerProfileEtag,
  customerProfileSelection,
  customerProfileValue,
} from './profile-value.js';

export { customerProfileDate } from './profile-value.js';

export function customerProfileService(config: Config, db: Databases) {
  const withCheckout = customerCheckoutScope(config, db);
  return {
    async read(user: Principal, scope: CustomerProfileScope) {
      return withCheckout(user, scope, 'share', async (tx, state) => {
        const [identity] = await tx
          .select({ id: MUser.id })
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
        if (!identity) throw missingCustomerProfile();
        // Current writer locks authorize identity/operator/counter. Operational
        // profile fields use the primary reader and never include wallet secrets.
        const [profile] = await db
          .get('primary')
          .select(customerProfileSelection)
          .from(MUser)
          .where(eq(MUser.id, identity.id))
          .limit(1);
        if (!profile) throw missingCustomerProfile();
        const value = customerProfileValue(profile);
        return customerProfileSchema.parse({
          customerId: state.customerId,
          checkoutVersion: state.version,
          etag: customerProfileEtag(value),
          editable: customerProfileEditable(state),
          profile: value,
        });
      });
    },
  };
}
