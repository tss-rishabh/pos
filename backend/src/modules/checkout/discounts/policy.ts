import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { requireRole, type Principal, type Role } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { CheckoutState } from '../contracts.js';
import { operationHash } from '../crypto.js';

export const storeDiscountReasons = [
  'Price mismatch (Online v/s POS)',
  'Price mismatch (Pricetag v/s POS)',
  'Price mismatch (During exchange)',
  'Founder billing',
  'Marketing activity',
  'Uniform billing',
  'Perfume tester',
  'Trial socks',
  'Personal Care',
] as const;
export const discountRemark = z
  .string()
  .trim()
  .min(3)
  .max(35)
  .refine((value) => /[^\s.]/u.test(value), 'Enter a meaningful discount remark.');
/**
 * Old PG remark (`create_order.html:5061-5136`): at least 3 characters and not only spaces or
 * dots; legacy has no maximum. 255 bounds the request (orders.pg_disc_comment via API-v2).
 */
export const pgDiscountRemark = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .refine((value) => /[^\s.]/u.test(value), 'Enter a meaningful discount remark.');
export const discountMetadataSchema = z.object({
  pg: z.object({ remark: pgDiscountRemark }).nullable(),
  store: z.object({ remark: discountRemark, reason: z.enum(storeDiscountReasons) }).nullable(),
});
export type DiscountMetadata = z.infer<typeof discountMetadataSchema>;
const role = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const decode = (fallback: unknown) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new AppError(
        503,
        'DISCOUNT_POLICY_INVALID',
        'Discount approval policy is not configured correctly.',
      );
    }
  }, z.unknown());
export interface DiscountPolicy {
  permittedRoles: Role[];
  exemptRoles: Role[];
  storeThresholds: Record<string, Record<string, string[]>>;
  sendToAllManagers: boolean;
  expirySeconds: number;
}
export function discountPolicy(env: NodeJS.ProcessEnv = process.env): DiscountPolicy {
  const config = z
    .object({
      PG_DISC_ROLE_PERM: decode([1, 2, 3, 4]).pipe(z.array(role).min(1)),
      PG_DISC_OTP_EXEMPT: decode([1, 2, 3]).pipe(z.array(role)),
      PG_DISC_STORE_MANAGER_PERCENTAGE: decode({}).pipe(
        z.record(
          z.string().regex(/^[1-9]\d*$/),
          z.record(z.string().regex(/^(?:100|[1-9]?\d)$/), z.array(z.email().max(254)).max(1000)),
        ),
      ),
      SEND_OTP_TO_ALL_MANAGERS: z.enum(['0', '1']).default('1'),
      PG_DISC_OTP_EX_VALUE: z.coerce.number().int().min(60).max(3600).default(600),
    })
    .parse(env);
  return {
    permittedRoles: config.PG_DISC_ROLE_PERM,
    exemptRoles: config.PG_DISC_OTP_EXEMPT,
    storeThresholds: config.PG_DISC_STORE_MANAGER_PERCENTAGE,
    sendToAllManagers: config.SEND_OTP_TO_ALL_MANAGERS === '1',
    expirySeconds: config.PG_DISC_OTP_EX_VALUE,
  };
}
export interface DiscountTerms {
  amount: string;
  pgAmount: string;
  storeAmount: string;
  productsTotal: string;
  comment: string;
  storeComment: string;
  storeReason: string;
  binding: string;
}
function amount(value: unknown): Decimal {
  const parsed = z
    .union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()])
    .safeParse(value ?? 0);
  if (!parsed.success)
    throw new AppError(502, 'INVALID_DISCOUNT_QUOTE', 'The checkout discount quote is invalid.');
  const result = new Decimal(parsed.data);
  if (result.decimalPlaces() > 2 || result.gt(2147483647))
    throw new AppError(502, 'INVALID_DISCOUNT_QUOTE', 'The checkout discount quote is invalid.');
  return result;
}
/** All prices and eligibility inputs come from the authoritative TSS quote. */
export function discountTerms(state: CheckoutState, secret: string): DiscountTerms {
  if (!state.quote || state.phase !== 'quoted')
    throw new AppError(
      409,
      'CHECKOUT_QUOTE_REQUIRED',
      'Refresh the final quote before requesting approval.',
    );
  const meta = z
    .object({ items: z.array(z.record(z.string(), z.unknown())) })
    .parse(state.quote.meta);
  const calculations = meta.items.find((item) => item.name === 'calculations');
  if (!calculations)
    throw new AppError(502, 'INVALID_DISCOUNT_QUOTE', 'The checkout discount quote is invalid.');
  // The cart also exposes named benefit rows. Calculations is authoritative when present.
  const pg = amount(
    calculations.used_pg_discount ??
      meta.items.find((item) => item.name === 'pg_discount')?.used_pg_discount,
  );
  const store = amount(
    calculations.used_store_discount_pg ??
      meta.items.find((item) => item.name === 'store_discount_pg')?.used_store_discount_pg,
  );
  const total = pg.plus(store),
    metadata = state.discountMetadata || { pg: null, store: null };
  if (total.gt(2147483647))
    throw new AppError(
      502,
      'INVALID_DISCOUNT_QUOTE',
      'The checkout discount exceeds the supported audit amount.',
    );
  if (!total.isZero() && calculations.products_total === undefined)
    throw new AppError(
      502,
      'INVALID_DISCOUNT_QUOTE',
      'The checkout discount quote is missing its products total.',
    );
  if ((!pg.isZero() && !metadata.pg) || (!store.isZero() && !metadata.store))
    throw new AppError(
      422,
      'DISCOUNT_REMARK_REQUIRED',
      'Save a remark and the store discount reason before submitting this sale.',
    );
  // AjaxOrderView (order/views.py:2706-2707): pg comment, then "|" + store comment.
  const storeComment = store.isZero() ? '' : metadata.store!.remark,
    comment = (pg.isZero() ? '' : metadata.pg!.remark) + (storeComment ? '|' + storeComment : '');
  const productsTotal = amount(calculations.products_total);
  if (!total.isZero() && productsTotal.plus(total).isZero())
    throw new AppError(502, 'INVALID_DISCOUNT_QUOTE', 'The checkout discount quote is invalid.');
  const binding = operationHash(
    'discount.approval.terms',
    {
      checkoutId: state.id,
      operatorId: state.operatorId,
      storeId: state.storeId,
      counterId: state.counterId,
      customerId: state.customerId || state.operatorCustomerId,
      products: state.quote.products,
      giftvouchers: state.quote.giftvouchers || null,
      calculations,
      metadata,
    },
    secret,
  );
  return {
    amount: total.toFixed(2),
    pgAmount: pg.toFixed(2),
    storeAmount: store.toFixed(2),
    productsTotal: productsTotal.toFixed(2),
    comment,
    storeComment,
    storeReason: store.isZero() ? '' : metadata.store!.reason,
    binding,
  };
}
/**
 * The discount the old checkout posts as `pg_discount` to AjaxPGDiscOTPSend:
 * `parseInt(pgDiscount) + parseInt(pgDiscountNew)` (`create_order.html:5137`, `:5328`, `:7301`).
 * Each input holds the cart's used PG / store (PG) discount, and `parseInt` truncates each one
 * separately before they are added. The amounts here are validated non-negative decimals with at
 * most two places, so `parseInt` is exactly Decimal truncation.
 */
export function legacyTruncatedDiscount(
  terms: Pick<DiscountTerms, 'pgAmount' | 'storeAmount'>,
): Decimal {
  return new Decimal(terms.pgAmount).trunc().plus(new Decimal(terms.storeAmount).trunc());
}
/**
 * AjaxPGDiscOTPSend (`order/views.py:4602-4618`): the greatest threshold not above
 * `float(pg_discount)/(float(total_amount)+float(pg_discount))*100`, where `pg_discount` is the
 * truncated sum above and `total_amount` is the cart's `products_total` (`#sub-total`,
 * `create_order.html:453-456`). The percentage is computed with IEEE doubles in the same order
 * as the Python source, so a tier boundary such as 10% resolves exactly as legacy does
 * (user decision, 20 November 2026). It only selects approvers; no money is derived from it.
 */
export function approverSelection(
  policy: DiscountPolicy,
  storeId: string,
  terms: Pick<DiscountTerms, 'pgAmount' | 'storeAmount' | 'productsTotal'>,
): { emails: string[]; fallback: boolean; exempt: boolean } {
  const discount = legacyTruncatedDiscount(terms).toNumber(),
    denominator = new Decimal(terms.productsTotal).toNumber() + discount;
  // Legacy raises ZeroDivisionError here; never pick a tier from NaN.
  if (denominator === 0)
    throw new AppError(502, 'INVALID_DISCOUNT_QUOTE', 'The checkout discount quote is invalid.');
  const percentage = (discount / denominator) * 100,
    thresholds = policy.storeThresholds[storeId] || {};
  let selected = '0';
  for (const threshold of Object.keys(thresholds).sort((a, b) => Number(a) - Number(b))) {
    if (percentage < Number(threshold)) break;
    selected = threshold;
  }
  const emails = thresholds[selected] || [];
  return {
    emails,
    fallback: !emails.length && policy.sendToAllManagers,
    exempt: !emails.length && !policy.sendToAllManagers,
  };
}

/**
 * Old PG discount (`create_order.html:303-328`): amount, Apply and remark are disabled with
 * "You do not have permission." unless the operator role is in PG_DISC_ROLE_PERM. Legacy
 * `AjaxPgDiscountView` (`order/views.py:2190`) does not recheck it; the API enforces the same
 * rule server-side (security decision). Removal and the store discount (PG)
 * (`AjaxStoreDiscountPGView`, `order/views.py:2237-2283`) have no role gate, as in legacy.
 */
export function assertDiscountApplyPermission(
  policy: Pick<DiscountPolicy, 'permittedRoles'>,
  user: Principal,
  kind: 'pg' | 'store',
  apply: boolean,
): void {
  if (kind !== 'pg' || !apply) return;
  try {
    requireRole(user, policy.permittedRoles);
  } catch {
    throw new AppError(403, 'PG_DISCOUNT_PERMISSION_DENIED', 'You do not have permission.');
  }
}
