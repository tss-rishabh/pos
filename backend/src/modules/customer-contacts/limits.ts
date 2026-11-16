import { eq } from 'drizzle-orm';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { contactWallTime } from './authority.js';
import type { CustomerContactOptions } from './options.js';
import type { CustomerContactStage } from './schema.js';
import { customerContactLimits as limits } from './schema.js';

export function contactAttemptLimit(channel: 'sms' | 'email', options: CustomerContactOptions) {
  return channel === 'email' ? 5 : options.VERIFICATION_COUNT;
}
/** Per-customer/stage and target/stage budgets survive proof cancellation and replacement. */
export async function consumeContactSend(
  tx: AdministrationTransaction,
  input: {
    customerId: string;
    targetKey: string;
    stage: CustomerContactStage;
    channel: 'sms' | 'email';
    now: number;
    zone: string;
    options: CustomerContactOptions;
  },
) {
  const day = contactWallTime(input.now, input.zone).slice(0, 10),
    count = input.channel === 'email' ? 5 : input.options.RESEND_COUNT;
  for (const key of [
    'customer:' + input.customerId + ':' + input.stage,
    input.targetKey + ':' + input.stage,
  ].sort()) {
    await tx
      .insert(limits)
      .values({ key, day, sends: 0, failures: 0, lastSentAt: 0 })
      .onDuplicateKeyUpdate({ set: { key } });
    const [previous] = await tx.select().from(limits).where(eq(limits.key, key)).for('update');
    if (!previous)
      throw new AppError(
        503,
        'CUSTOMER_CONTACT_LIMIT_UNAVAILABLE',
        'Contact verification is unavailable.',
      );
    const row =
      previous.day === day ? previous : { ...previous, day, sends: 0, failures: 0, lastSentAt: 0 };
    if (
      row.sends >= count ||
      row.failures >= count * contactAttemptLimit(input.channel, input.options)
    )
      throw new AppError(
        429,
        'CUSTOMER_CONTACT_DAILY_LIMIT',
        'The contact verification daily limit has been reached.',
      );
    if (row.lastSentAt + 30000 > input.now)
      throw new AppError(
        429,
        'CUSTOMER_CONTACT_RESEND_WAIT',
        'Wait30 seconds before requesting another contact code.',
      );
    await tx
      .update(limits)
      .set({ day, sends: row.sends + 1, failures: row.failures, lastSentAt: input.now })
      .where(eq(limits.key, key));
  }
}
export async function recordContactFailure(
  tx: AdministrationTransaction,
  customerId: string,
  targetKey: string,
  stage: CustomerContactStage,
) {
  for (const key of ['customer:' + customerId + ':' + stage, targetKey + ':' + stage].sort()) {
    const [row] = await tx.select().from(limits).where(eq(limits.key, key)).for('update');
    if (row)
      await tx
        .update(limits)
        .set({ failures: row.failures + 1 })
        .where(eq(limits.key, key));
  }
}
