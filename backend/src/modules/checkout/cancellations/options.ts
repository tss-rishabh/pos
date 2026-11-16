import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import {
  cancellationBenefitPolicy,
  cancellationMembershipContract,
  type CancellationBenefitProfile,
} from './benefit-contracts.js';
import { membershipContextContract } from './membership-context.js';
import { pendingCancellationContract } from './contracts.js';
export function pendingCancellationOptions(env: NodeJS.ProcessEnv = process.env) {
  const value = z
    .object({
      UPSTREAM_POS_MEMBERSHIP_CONTEXT_CONTRACT: z.literal(membershipContextContract).optional(),
      POS_PENDING_CANCELLATION_BENEFIT_POLICY: z.literal(cancellationBenefitPolicy).optional(),
      GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT: z.literal('pos-wallet-user-lock-v1').optional(),
      POS_PENDING_CANCELLATION_VOUCHER_LOCK_CONTRACT: z
        .literal('pos-voucher-user-lock-v1')
        .optional(),
      POS_PENDING_CANCELLATION_MEMBERSHIP_WRITER_CONTRACT: z
        .literal(cancellationMembershipContract)
        .optional(),
      POS_PENDING_CANCELLATION_MEMBERSHIP_CACHE_CONTRACT: z
        .literal('pos-membership-fresh-reader-v1')
        .optional(),
      POS_PENDING_CANCELLATION_MEMBERSHIP_PROOF_KEY: z.string().min(32).optional(),
      POS_PENDING_CANCELLATION_CONTRACT: z.literal(pendingCancellationContract).optional(),
      POS_PENDING_CANCELLATION_MEMBERSHIP_PRODUCT_IDS: z
        .string()
        .transform((raw, ctx) => {
          try {
            return z
              .array(identifier)
              .max(1000)
              .parse(JSON.parse(raw) as unknown);
          } catch {
            ctx.addIssue({
              code: 'custom',
              message:
                'Cancellation membership products must be a reviewed JSON array of canonical IDs.',
            });
            return z.NEVER;
          }
        })
        .optional(),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, item]) => item !== '')));
  const benefitProfile: CancellationBenefitProfile | undefined =
    value.POS_PENDING_CANCELLATION_BENEFIT_POLICY &&
    value.GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT &&
    value.POS_PENDING_CANCELLATION_VOUCHER_LOCK_CONTRACT
      ? {
          policy: value.POS_PENDING_CANCELLATION_BENEFIT_POLICY,
          walletWriterContract: value.GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT,
          voucherWriterContract: value.POS_PENDING_CANCELLATION_VOUCHER_LOCK_CONTRACT,
          membershipWriterContract: value.POS_PENDING_CANCELLATION_MEMBERSHIP_WRITER_CONTRACT,
          membershipCacheContract:
            value.UPSTREAM_POS_MEMBERSHIP_CONTEXT_CONTRACT === membershipContextContract
              ? value.POS_PENDING_CANCELLATION_MEMBERSHIP_CACHE_CONTRACT
              : undefined,
          membershipProofKey: value.POS_PENDING_CANCELLATION_MEMBERSHIP_PROOF_KEY,
        }
      : undefined;
  return {
    ...(benefitProfile ? { benefitProfile } : {}),
    contract: value.POS_PENDING_CANCELLATION_CONTRACT,
    membershipProductIds: value.POS_PENDING_CANCELLATION_MEMBERSHIP_PRODUCT_IDS,
  };
}
export type PendingCancellationOptions = ReturnType<typeof pendingCancellationOptions>;
