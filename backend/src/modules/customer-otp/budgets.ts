import { eq } from 'drizzle-orm';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { contactWallTime } from '../customer-contacts/authority.js';
import { customerOtpBudgets as budgets } from './schema.js';
import type { CustomerOtpOptions } from './options.js';

export const customerOtpAttemptLimit = () =>
  new AppError(
    429,
    'CUSTOMER_OTP_ATTEMPT_LIMIT',
    'The customer verification attempt limit has been reached. Wait before trying again.',
  );
export async function lockedCustomerOtpBudgets(
  tx: AdministrationTransaction,
  keys: readonly string[],
  now: number,
  zone: string,
) {
  const day = contactWallTime(now, zone).slice(0, 10);
  const rows: (typeof budgets.$inferSelect)[] = [];
  for (const key of [...new Set(keys)].sort()) {
    await tx
      .insert(budgets)
      .values({
        key,
        day,
        sends: 0,
        failures: 0,
        windowFailures: 0,
        windowResetAt: now + 300000,
        lastSentAt: 0,
      })
      .onDuplicateKeyUpdate({ set: { key } });
    const [previous] = await tx.select().from(budgets).where(eq(budgets.key, key)).for('update');
    if (!previous)
      throw new AppError(
        503,
        'CUSTOMER_OTP_BUDGET_UNAVAILABLE',
        'Customer verification is unavailable.',
      );
    const row = {
      ...previous,
      day,
      sends: previous.day === day ? previous.sends : 0,
      failures: previous.day === day ? previous.failures : 0,
      windowFailures: previous.windowResetAt > now ? previous.windowFailures : 0,
      windowResetAt: previous.windowResetAt > now ? previous.windowResetAt : now + 300000,
    };
    await tx.update(budgets).set(row).where(eq(budgets.key, key));
    rows.push(row);
  }
  return rows;
}
export async function consumeCustomerOtpSend(
  tx: AdministrationTransaction,
  keys: readonly string[],
  now: number,
  zone: string,
  options: CustomerOtpOptions,
) {
  const rows = await lockedCustomerOtpBudgets(tx, keys, now, zone);
  for (const row of rows) {
    if (
      row.sends >= options.CUSTOMER_OTP_SENDS_PER_DAY ||
      row.failures >= options.CUSTOMER_OTP_FAILURES_PER_DAY ||
      row.windowFailures >= options.CUSTOMER_OTP_FAILURES_PER_WINDOW
    )
      throw customerOtpAttemptLimit();
    if (row.lastSentAt + 60000 > now)
      throw new AppError(
        429,
        'CUSTOMER_OTP_SEND_LIMIT',
        'Wait one minute before requesting another customer verification code.',
      );
  }
  for (const row of rows)
    await tx
      .update(budgets)
      .set({ sends: row.sends + 1, lastSentAt: now })
      .where(eq(budgets.key, row.key));
}
