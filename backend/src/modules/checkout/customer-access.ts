import { eq } from 'drizzle-orm';
import { MUser } from '../../db/legacy-schema.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
export function activeCheckoutCustomer(
  customer: { active: number; blocked: number | null; disabled: number | null } | undefined,
): boolean {
  return (
    !!customer &&
    customer.active === 1 &&
    [null, 0].includes(customer.blocked) &&
    [null, 0].includes(customer.disabled)
  );
}

/** Fresh writer eligibility; cached API auth-user data cannot authorize a financial mutation. */
export async function assertActiveCheckoutCustomer(
  tx: Pick<ReturnType<Databases['get']>, 'select'>,
  customerId: string,
) {
  const [customer] = await tx
    .select({ active: MUser.status, blocked: MUser.is_block, disabled: MUser.is_disabled })
    .from(MUser)
    .where(eq(MUser.id, BigInt(customerId)))
    .limit(1)
    .for('share');
  if (!activeCheckoutCustomer(customer))
    throw new AppError(
      409,
      'CHECKOUT_CUSTOMER_UNAVAILABLE',
      'The customer is not currently eligible for this checkout. Keep its reference for reconciliation.',
    );
}
