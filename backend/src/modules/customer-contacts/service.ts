import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { customerCheckoutScope } from '../customer-insights/checkout-scope.js';
import { contactWallTime } from './authority.js';
import type { ContactScope, ContactWorkspace } from './contracts.js';
import { contactUsers } from './legacy-schema.js';

const placeholderEmail = (email: string) => email.includes('temp.id');

/**
 * Legacy `AjaxUpdateUserMobile` / `AjaxUpdateUserEmail` (`order/views.py:3369-3399`): an
 * "already registered" check over every `users` row, then a plain update of
 * `users.telephone` / `users.email` (Django `save()` also sets `updated_at`).
 *
 * Security (W5): legacy accepts any posted `id`. The rewrite only updates the customer
 * attached to the operator's own open checkout, and only in the state where the legacy page
 * offers the action (no telephone yet; a `temp.id` placeholder email).
 */
export function customerContactService(
  config: Config,
  db: Databases,
  clock: () => number = Date.now,
) {
  const withCheckout = customerCheckoutScope(config, db);
  return {
    async workspace(user: Principal, scope: ContactScope): Promise<ContactWorkspace> {
      return withCheckout(user, scope, 'share', async (tx, state) => {
        const [customer] = await tx
          .select({ email: contactUsers.email, telephone: contactUsers.telephone })
          .from(contactUsers)
          .where(eq(contactUsers.id, BigInt(state.customerId)))
          .limit(1);
        if (!customer) throw invalidUser();
        return {
          customerId: state.customerId,
          email: customer.email,
          canAddTelephone: !customer.telephone,
          canChangeEmail: placeholderEmail(customer.email),
        };
      });
    },
    async updateTelephone(user: Principal, scope: ContactScope, phoneNumber: string) {
      return withCheckout(user, scope, 'update', async (tx, state) => {
        const [customer] = await tx
          .select({ telephone: contactUsers.telephone })
          .from(contactUsers)
          .where(eq(contactUsers.id, BigInt(state.customerId)))
          .limit(1)
          .for('update');
        if (!customer) throw invalidUser();
        if (customer.telephone)
          throw new AppError(
            409,
            'CUSTOMER_TELEPHONE_PRESENT',
            'This customer already has a mobile number.',
          );
        const [taken] = await tx
          .select({ id: contactUsers.id })
          .from(contactUsers)
          .where(eq(contactUsers.telephone, phoneNumber))
          .limit(1);
        if (taken)
          throw new AppError(409, 'CONTACT_ALREADY_REGISTERED', 'Number already registered');
        await tx
          .update(contactUsers)
          .set({
            telephone: phoneNumber,
            updatedAt: contactWallTime(clock(), config.BUSINESS_TIMEZONE),
          })
          .where(eq(contactUsers.id, BigInt(state.customerId)));
        return { message: 'Saved Successfully', mobile: phoneNumber };
      });
    },
    async updateEmail(user: Principal, scope: ContactScope, email: string) {
      return withCheckout(user, scope, 'update', async (tx, state) => {
        const [customer] = await tx
          .select({ email: contactUsers.email })
          .from(contactUsers)
          .where(eq(contactUsers.id, BigInt(state.customerId)))
          .limit(1)
          .for('update');
        if (!customer) throw invalidUser();
        if (!placeholderEmail(customer.email))
          throw new AppError(
            409,
            'CUSTOMER_EMAIL_PRESENT',
            'This customer already has an email address.',
          );
        const [taken] = await tx
          .select({ id: contactUsers.id })
          .from(contactUsers)
          .where(eq(contactUsers.email, email))
          .limit(1);
        if (taken)
          throw new AppError(409, 'CONTACT_ALREADY_REGISTERED', 'Email already registered');
        await tx
          .update(contactUsers)
          .set({ email, updatedAt: contactWallTime(clock(), config.BUSINESS_TIMEZONE) })
          .where(eq(contactUsers.id, BigInt(state.customerId)));
        return { message: 'Email successfully changed', email };
      });
    },
  };
}
const invalidUser = () => new AppError(404, 'CUSTOMER_NOT_FOUND', 'Invalid user id');
export type CustomerContactService = ReturnType<typeof customerContactService>;
