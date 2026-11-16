import { eq } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { customerOtpViewSchema, type CustomerOtpView } from './contracts.js';
import { customerOtpChallenges, customerOtpDeliveries } from './schema.js';

export type CustomerOtpChallenge = typeof customerOtpChallenges.$inferSelect;
export async function projectCustomerOtp(
  tx: AdministrationTransaction,
  row: CustomerOtpChallenge,
  now: number,
): Promise<CustomerOtpView> {
  let status: CustomerOtpView['status'] = 'rejected';
  const verifiedUntil =
    row.state === 'VERIFIED' && row.verifiedUntil && row.verifiedUntil > now
      ? row.verifiedUntil
      : null;
  if (verifiedUntil) status = 'sent';
  else if (row.state === 'ACTIVE' && row.expiresAt > now) {
    const jobs = await tx
      .select({ state: customerOtpDeliveries.state })
      .from(customerOtpDeliveries)
      .where(eq(customerOtpDeliveries.challengeId, row.id))
      .limit(3);
    status = jobs.some((job) => job.state === 'ACCEPTED')
      ? 'sent'
      : jobs.some((job) => job.state === 'UNCERTAIN' || job.state === 'SENDING')
        ? 'uncertain'
        : jobs.some((job) => job.state === 'PENDING')
          ? 'pending'
          : 'rejected';
  }
  return customerOtpViewSchema.parse({
    id: row.id,
    status,
    expiresAt: row.expiresAt,
    verifiedUntil,
    contact: row.contact,
  });
}
