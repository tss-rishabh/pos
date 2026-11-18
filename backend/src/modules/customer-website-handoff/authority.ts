import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser, PosUser } from '../../db/legacy-schema.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { applicationDigest } from '../application-links/domain.js';
import type { customerOtpService } from '../customer-otp/index.js';
import {
  customerCheckoutScope,
  customerProfileEditable,
} from '../customer-insights/checkout-scope.js';
import { activeCheckoutCustomer } from '../checkout/customer-access.js';
import {
  readCustomerContactBinding,
  sameCustomerContact,
} from '../checkout/customer-contact-authority.js';
import { checkoutCustomerOtpScope } from '../checkout/customer-verification.js';
import type { CheckoutState } from '../checkout/contracts.js';
import type { WebsiteHandoffScope, WebsiteHandoffSession } from './contracts.js';

/** Redis POS session liveness (auth sessions.alive); replaces the pos_rewrite_sessions read. */
export type WebsiteSessionProbe = (
  sessionId: string,
  userId: string,
  transaction: AdministrationTransaction,
) => Promise<boolean>;
export type WebsiteVerification = Pick<ReturnType<typeof customerOtpService>, 'assertVerified'>;
export const changed = () =>
  new AppError(
    409,
    'CUSTOMER_WEBSITE_SCOPE_CHANGED',
    'This customer or sale changed. Verify the current sale before continuing.',
  );
export const expired = () =>
  new AppError(
    410,
    'CUSTOMER_WEBSITE_HANDOFF_EXPIRED',
    'This website link expired or was already used.',
  );
export function websiteHandoffAuthority(
  config: Config,
  db: Databases,
  verification: WebsiteVerification | undefined,
  clock: () => number,
  sessionAlive?: WebsiteSessionProbe,
) {
  const withCheckout = customerCheckoutScope(config, db);
  async function principal(
    tx: AdministrationTransaction,
    operatorId: string,
    storeId: string,
  ): Promise<Principal> {
    const [row] = await tx
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(operatorId)))
      .limit(1)
      .for('share');
    if (!row?.is_active) throw expired();
    const role = z
        .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
        .safeParse(row.role),
      userType = z.union([z.literal(1), z.literal(2)]).safeParse(row.user_type);
    if (!role.success || !userType.success) throw expired();
    // This is a narrow scope assertion, independently reauthorized by the
    // transaction-scoped check-in authority before the checkout is used.
    return {
      id: operatorId,
      role: role.data,
      userType: userType.data,
      storeIds: [storeId],
      name: '',
      email: '',
    };
  }
  async function current(
    tx: AdministrationTransaction,
    user: Principal,
    state: CheckoutState & { customerId: string },
    session: WebsiteHandoffSession,
  ) {
    if (
      !verification ||
      !customerProfileEditable(state) ||
      !state.verificationChallenge ||
      !state.verifiedCustomerContact ||
      !state.verifiedCustomerUntil ||
      !Number.isSafeInteger(state.verifiedCustomerUntil) ||
      state.verifiedCustomerUntil <= clock()
    )
      throw new AppError(
        403,
        'CUSTOMER_VERIFICATION_REQUIRED',
        'Verify this customer and confirm their website consent first.',
      );
    const [account] = await tx
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    if (!account?.is_active) throw expired();
    const version = await currentAuthenticationVersion(tx, account);
    if (
      session.expiresAt <= clock() ||
      (sessionAlive && !(await sessionAlive(session.id, user.id, tx)))
    )
      throw expired();
    await verification.assertVerified(
      tx,
      user,
      checkoutCustomerOtpScope(state),
      state.verificationChallenge.id,
      state.verifiedCustomerContact,
      state.verifiedCustomerUntil,
    );
    const contact = await readCustomerContactBinding(tx, state.customerId);
    if (
      !sameCustomerContact(contact, state.verifiedCustomerContact) ||
      !sameCustomerContact(contact, state.verificationChallenge.contact)
    )
      throw changed();
    const [operatorCustomer] = await tx
      .select({
        active: MUser.status,
        blocked: MUser.is_block,
        disabled: MUser.is_disabled,
        operatorId: sql<string>`CAST(users.pos_admin_id AS CHAR)`,
        kind: sql<string>`CAST(users.user_type AS CHAR)`,
      })
      .from(MUser)
      .where(eq(MUser.id, BigInt(state.operatorCustomerId)))
      .limit(1)
      .for('share');
    if (
      !activeCheckoutCustomer(operatorCustomer) ||
      operatorCustomer?.operatorId !== user.id ||
      operatorCustomer.kind !== '8'
    )
      throw changed();
    return {
      authorityHash: applicationDigest(
        config.SESSION_SECRET,
        'customer-website-authority',
        JSON.stringify([
          state.id,
          state.version,
          state.operatorId,
          state.operatorCustomerId,
          state.customerId,
          state.storeId,
          state.counterId,
          session.id,
          version,
          state.verificationChallenge.id,
          state.verifiedCustomerUntil,
          contact.revision,
          contact.digest,
        ]),
      ),
      verifiedUntil: state.verifiedCustomerUntil,
      sessionExpiresAt: session.expiresAt,
    };
  }
  return {
    withCheckout,
    current,
    principal,
    async withPrincipal<T>(
      operatorId: string,
      scope: WebsiteHandoffScope,
      action: (user: Principal) => Promise<T>,
    ) {
      const user = await db
        .get('writer')
        .transaction((tx) => principal(tx, operatorId, scope.storeId));
      return action(user);
    },
  };
}
