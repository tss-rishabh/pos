import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PosUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentOperatorRole } from '../administration/authorization.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { CheckoutState } from '../checkout/contracts.js';
import { voucherUnavailable } from './errors.js';

export async function authorizeVoucherIssuer(tx: AdministrationTransaction, user: Principal) {
  await assertCurrentOperatorRole(tx, user.id, [1, 2, 3]);
  const [operator] = await tx
    .select({ type: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (operator?.type !== 1)
    throw new AppError(
      403,
      'GLOBAL_VOUCHER_ACCESS_DENIED',
      'Gift voucher issuance requires an internal administrator.',
    );
}
export async function assertVoucherLegacyCompatibility(tx: AdministrationTransaction) {
  const result =
    await tx.execute(sql`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,IS_NULLABLE AS nullable,COLUMN_TYPE AS columnType
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND
    ((TABLE_NAME='coupons' AND COLUMN_NAME='end_date') OR
    (TABLE_NAME='gift_vouchers' AND COLUMN_NAME IN ('start_date','end_date')) OR
    (TABLE_NAME='gift_voucher_history' AND COLUMN_NAME='platform'))`);
  const rows = z
    .array(
      z.object({
        tableName: z.string(),
        columnName: z.string(),
        nullable: z.enum(['YES', 'NO']),
        columnType: z.string(),
      }),
    )
    .parse(result[0]);
  if (
    rows.length !== 4 ||
    rows.filter((r) => r.columnName !== 'platform').some((r) => r.nullable !== 'YES') ||
    !rows.find((r) => r.tableName === 'gift_voucher_history')?.columnType.includes("'GV_ADD'")
  )
    throw voucherUnavailable();
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
