import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { PosUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentOperatorRole } from '../administration/authorization.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { CheckoutState } from '../checkout/contracts.js';

/**
 * core/views.py:1482 `advance_permisson("[1,2,3]")`; the Special Permission page also excludes
 * franchise users (`user_type_exempt("[2]")`, core/views.py:1176), enforced here too.
 */
export async function authorizeVoucherIssuer(tx: AdministrationTransaction, user: Principal) {
  await assertCurrentOperatorRole(tx, user.id, [1, 2, 3]);
  const [operator] = await tx
    .select({ type: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (!operator || operator.type === 2)
    throw new AppError(
      403,
      'GLOBAL_VOUCHER_ACCESS_DENIED',
      'Gift voucher issuance requires an internal administrator.',
    );
}
function hasVoucherMeta(raw: unknown): boolean {
  const projected = z
    .object({ items: z.array(z.record(z.string(), z.unknown())).max(100) })
    .safeParse(raw);
  if (!projected.success)
    throw new AppError(
      409,
      'VOUCHER_CART_REFRESH_REQUIRED',
      'Refresh the sale before converting a voucher.',
    );
  return projected.data.items.some(
    (item) => item.name === 'gift_voucher' || Object.hasOwn(item, 'gift_voucher_value'),
  );
}
export function assertConversionCart(state: CheckoutState) {
  if (hasVoucherMeta(state.cart?.meta))
    throw new AppError(
      409,
      'VOUCHER_ALREADY_APPLIED',
      'Remove the applied voucher before converting a voucher to TSS Money.',
    );
  if (state.quote?.meta !== undefined && hasVoucherMeta(state.quote.meta))
    throw new AppError(
      409,
      'VOUCHER_ALREADY_APPLIED',
      'Remove the applied voucher before converting a voucher to TSS Money.',
    );
  if (state.quote?.cart !== undefined) {
    const cart = z.object({ meta: z.unknown() }).safeParse(state.quote.cart);
    if (!cart.success || hasVoucherMeta(cart.data.meta))
      throw new AppError(
        409,
        'VOUCHER_CART_REFRESH_REQUIRED',
        'Refresh the sale before converting a voucher.',
      );
  }
}
