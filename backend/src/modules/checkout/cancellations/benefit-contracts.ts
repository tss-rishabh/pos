import { z } from 'zod';
export const cancellationBenefitPolicy = 'pos-cancellation-original-expiry-v1';
export const cancellationMembershipContract = 'pos-cancellation-membership-provenance-v2';
export const stagedCancellationMembershipContract = 'pos-cancellation-membership-staged-v2';
export interface CancellationBenefitProfile {
  /** Approved policy; activation also requires the deployed shared-writer contracts. */
  policy: typeof cancellationBenefitPolicy;
  walletWriterContract: 'pos-wallet-user-lock-v1';
  voucherWriterContract: 'pos-voucher-user-lock-v1';
  membershipWriterContract?: typeof cancellationMembershipContract;
  membershipCacheContract?: 'pos-membership-fresh-reader-v1';
  membershipProofKey?: string;
}
const amount = z.string().regex(/^\d+(?:\.\d+)?$/);
export const cancellationBenefitSummarySchema = z
  .object({
    policy: z.literal(cancellationBenefitPolicy),
    moneyCredited: amount,
    moneyExpired: amount,
    pointsCredited: amount,
    pointsExpired: amount,
    voucherCredited: amount,
    voucherAvailable: z.boolean().nullable(),
    membership: z.enum(['unchanged', 'deactivated', 'prior-entitlement-restored']),
  })
  .strict();
export type CancellationBenefitSummary = z.infer<typeof cancellationBenefitSummarySchema>;
export interface CancellationBenefitLine {
  lineId: string;
  productId: string;
  money: number;
  points: number;
  voucher: number;
}
export interface CancellationBenefitScope {
  orderId: string;
  customerId: string;
  voucherId: string;
  headerHash: string;
  money: number;
  points: number;
  voucher: number;
  lines: readonly CancellationBenefitLine[];
  membership: boolean;
  timestamp: string;
}
