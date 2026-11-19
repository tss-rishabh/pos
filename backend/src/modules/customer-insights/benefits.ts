import { createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { customerCheckoutScope, missingCustomerProfile } from './checkout-scope.js';
import { customerProfileScope, type CustomerProfileScope } from './contracts.js';
import { customerBenefits } from './benefits-contracts.js';
import type { AppCashbackCampaign } from './benefits-gateway.js';
import {
  benefitAddons,
  benefitCustomers,
  benefitMemberships,
  benefitVouchers,
} from './benefits-schema.js';
import { customerMembership, customerWalletDisplay, membershipExpiry } from './benefits-values.js';

export function customerBenefitsService(
  config: Config,
  db: Databases,
  campaign: AppCashbackCampaign,
  clock: () => number = Date.now,
) {
  const withCheckout = customerCheckoutScope(config, db);
  async function capture(user: Principal, scope: CustomerProfileScope) {
    return withCheckout(user, scope, 'share', async (tx, state) => {
      const [customer] = await tx
        .select({
          id: benefitCustomers.id,
          email: benefitCustomers.email,
          platform: benefitCustomers.platform,
        })
        .from(benefitCustomers)
        .where(
          and(
            eq(benefitCustomers.id, BigInt(state.customerId)),
            eq(benefitCustomers.active, 1),
            or(isNull(benefitCustomers.blocked), eq(benefitCustomers.blocked, 0)),
            or(isNull(benefitCustomers.disabled), eq(benefitCustomers.disabled, 0)),
          ),
        )
        .limit(1)
        .for('share');
      if (!customer) throw missingCustomerProfile();
      return {
        ...customer,
        version: state.version,
        binding: createHmac('sha256', config.SESSION_SECRET)
          .update(JSON.stringify([String(customer.id), customer.email, customer.platform]))
          .digest('hex'),
      };
    });
  }
  return {
    async read(user: Principal, scope: CustomerProfileScope) {
      customerProfileScope.parse(scope);
      const original = await capture(user, scope);
      // Indexed unique joins and a recipient-index count replace independent
      // per-field round trips. No voucher codes, credentials or wallet ledger rows.
      const [rows, campaignActive] = await Promise.all([
        db
          .get('primary')
          .select({
            id: benefitCustomers.id,
            email: benefitCustomers.email,
            platform: benefitCustomers.platform,
            money: benefitCustomers.money,
            points: benefitCustomers.points,
            createdAt: benefitCustomers.createdAt,
            membershipEntity: benefitMemberships.entity,
            membershipValue: benefitMemberships.value,
            membershipActive: benefitMemberships.active,
            isAppUser: benefitAddons.isAppUser,
            vouchers: sql<string>`${db
              .get('primary')
              .select({ count: sql<string>`CAST(COUNT(*) AS CHAR)` })
              .from(benefitVouchers)
              .where(
                and(eq(benefitVouchers.recipient, original.email), eq(benefitVouchers.active, 1)),
              )}`,
          })
          .from(benefitCustomers)
          .leftJoin(
            benefitMemberships,
            and(
              eq(benefitMemberships.entity, original.email),
              eq(benefitMemberships.attribute, 'EXCLUSIVE_EXPIRY'),
            ),
          )
          .leftJoin(benefitAddons, eq(benefitAddons.customerId, benefitCustomers.id))
          .where(eq(benefitCustomers.id, original.id))
          .limit(1),
        campaign.active(),
      ]);
      // Never hold writer/customer/check-in locks across a CMS request.
      const current = await capture(user, scope),
        row = rows[0];
      if (
        current.version !== original.version ||
        current.binding !== original.binding ||
        !row ||
        row.email !== current.email ||
        row.platform !== current.platform
      )
        throw new AppError(
          409,
          'CUSTOMER_BENEFITS_CONTEXT_CHANGED',
          'This sale changed. Reopen customer benefits.',
        );
      const now = Temporal.Instant.fromEpochMilliseconds(clock())
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime();
      return customerBenefits.parse({
        customerId: String(current.id),
        checkoutVersion: current.version,
        membership: customerMembership(
          row.membershipEntity === null
            ? undefined
            : { value: row.membershipValue, active: row.membershipActive },
          now,
        ),
        wallet: {
          money: customerWalletDisplay(row.money),
          points: customerWalletDisplay(row.points),
        },
        app: {
          isAppUser: row.isAppUser !== null && row.isAppUser !== 0,
          discountEligible: row.platform === 'STORE_FRONT_USER' ? false : campaignActive,
        },
        activeGiftVoucherCount: row.vouchers,
        customerSince: membershipExpiry(row.createdAt),
        fetchedAt: new Date(clock()).toISOString(),
      });
    },
  };
}
