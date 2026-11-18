import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, exists, gte, inArray, isNull, lte, ne, notInArray } from 'drizzle-orm';
import { MUser, Order } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  contactBankTransfers as bank,
  contactCoupons as coupons,
  contactCouponUsers as couponUsers,
  contactGiftVouchers as vouchers,
  contactJuspayCustomers as juspay,
  contactMembershipCopies as copies,
  contactRefundAlternatives as alternatives,
  contactRefundRequests as refunds,
  contactUserEav as eav,
  contactWelcomeOffers as welcome,
} from './legacy-schema.js';

const invalid = () =>
  new AppError(
    409,
    'CUSTOMER_CONTACT_REFERENCES_INVALID',
    'Customer reference data needs review before adding this contact.',
  );
/** Mirrors source UserController.is_real_email, including the established temp.id placeholder convention. */
export function hasRealCustomerEmail(email: string | null) {
  const value = (email || '').trim();
  return value !== '' && value !== 'None' && !value.includes('temp.id');
}
export async function assertEmailNotRegistered(tx: AdministrationTransaction, email: string) {
  const [user] = await tx
    .select({ id: MUser.id })
    .from(MUser)
    .where(eq(MUser.email, email))
    .limit(1)
    .for('share');
  const [member] = await tx
    .select({ entity: eav.entity })
    .from(eav)
    .where(eq(eav.entity, email))
    .limit(1)
    .for('share');
  if (user || member)
    throw new AppError(
      409,
      'CUSTOMER_CONTACT_ALREADY_REGISTERED',
      'This email is already registered.',
    );
}
export async function assertNoEmployeeContactChange(
  tx: AdministrationTransaction,
  customerId: string,
  now: Temporal.Instant,
) {
  // Source has_active_employee_coupon uses an explicit UTC→Asia/Kolkata conversion.
  const wall = now
    .toZonedDateTimeISO('Asia/Kolkata')
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
  const [row] = await tx
    .select({ id: coupons.id })
    .from(couponUsers)
    .innerJoin(coupons, eq(coupons.id, couponUsers.couponId))
    .where(
      and(
        eq(couponUsers.userId, BigInt(customerId)),
        eq(coupons.employee, 1),
        eq(coupons.deleted, 0),
        lte(coupons.start, wall),
        gte(coupons.end, wall),
      ),
    )
    .limit(1)
    .for('share');
  if (row)
    throw new AppError(409, 'CUSTOMER_CONTACT_EMPLOYEE_EMAIL', 'Employee email cannot be changed.');
}
function activeMembershipExpiry(rows: readonly (typeof eav.$inferSelect)[], wall: string) {
  const row = rows.find((item) => item.attribute === 'EXCLUSIVE_EXPIRY' && item.active === 1);
  if (!row?.value) return null;
  // Python compares parse(value) with naive datetime.now(); timezone-aware values return None via TypeError.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(row.value)) return null;
  try {
    const value = Temporal.PlainDateTime.from(
      row.value.length === 10 ? row.value + 'T00:00:00' : row.value.replace(' ', 'T'),
    );
    return Temporal.PlainDateTime.compare(
      value,
      Temporal.PlainDateTime.from(wall.replace(' ', 'T')),
    ) > 0
      ? row.value
      : null;
  } catch {
    throw invalid();
  }
}
/** Caller holds its scoped customer row and sorted contact mutexes. All mutations remain in its transaction. */
export async function carryCustomerEmailReferences(
  tx: AdministrationTransaction,
  input: {
    customerId: string;
    oldEmail: string;
    newEmail: string;
    wallTime: string;
    refundSuccess: 'SUCCESS';
    refundFailed: 'FAILED';
  },
) {
  const customerId = BigInt(input.customerId);
  if (customerId <= 2147483647n) {
    const [current] = await tx
      .select({ id: juspay.id, email: juspay.email })
      .from(juspay)
      .where(and(eq(juspay.userId, Number(customerId)), isNull(juspay.deletedAt)))
      .orderBy(asc(juspay.id))
      .limit(1)
      .for('update');
    if (current && current.email !== input.newEmail) {
      const [taken] = await tx
        .select({ id: juspay.id })
        .from(juspay)
        .where(eq(juspay.email, input.newEmail))
        .limit(1)
        .for('share');
      if (!taken)
        await tx.update(juspay).set({ email: input.newEmail }).where(eq(juspay.id, current.id));
    }
  }
  const old = input.oldEmail.trim();
  let shared = false;
  if (old !== '' && old !== 'None') {
    const sharedUsers = await tx
      .select({ id: MUser.id })
      .from(MUser)
      .where(and(eq(MUser.email, input.oldEmail), ne(MUser.id, customerId)))
      .orderBy(asc(MUser.id))
      .limit(1001)
      .for('share');
    if (sharedUsers.length > 1000) throw invalid();
    shared = sharedUsers.length > 0;
    const memberships = await tx
      .select()
      .from(eav)
      .where(eq(eav.entity, input.oldEmail))
      .for('update');
    if (memberships.length) {
      if (!shared)
        await tx.update(eav).set({ entity: input.newEmail }).where(eq(eav.entity, input.oldEmail));
      else {
        const expiry = activeMembershipExpiry(memberships, input.wallTime);
        await tx.insert(eav).values(
          memberships.map((row) => ({
            ...row,
            entity: input.newEmail,
            updatedAt: input.wallTime,
          })),
        );
        if (expiry) {
          if (expiry.length > 64) throw invalid();
          await tx.insert(copies).values({
            userId: customerId,
            oldEmail: input.oldEmail,
            newEmail: input.newEmail,
            sharedUserIds: sharedUsers.map((row) => row.id.toString()).join(','),
            exclusiveExpiry: expiry,
            createdAt: input.wallTime,
          });
        }
      }
    }
    if (!shared) {
      await tx
        .update(vouchers)
        .set({ recipient: input.newEmail })
        .where(eq(vouchers.recipient, input.oldEmail));
      if (input.newEmail.length <= 55)
        await tx
          .update(welcome)
          .set({ email: input.newEmail })
          .where(eq(welcome.email, input.oldEmail));
    }
  }
  const ownedOrders = tx.select({ id: Order.id }).from(Order).where(eq(Order.user, customerId));
  await tx
    .update(bank)
    .set({ email: input.newEmail })
    .where(
      and(
        notInArray(bank.status, [input.refundSuccess, input.refundFailed]),
        inArray(bank.orderId, ownedOrders),
      ),
    );
  const failed = exists(
    tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.id, alternatives.refundRequestId), eq(refunds.completed, 'FAILED'))),
  );
  const eligible = and(
    eq(alternatives.status, 'PENDING'),
    inArray(alternatives.orderId, ownedOrders),
    failed,
  );
  await tx.update(alternatives).set({ email: input.newEmail }).where(eligible);
  return { sharedOldEmail: shared };
}
