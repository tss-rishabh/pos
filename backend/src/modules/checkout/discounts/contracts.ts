import { z } from 'zod';
import type { Principal } from '../../../domain/access.js';
import type { CheckoutState } from '../contracts.js';
import type { DiscountTerms } from './policy.js';

/**
 * `pos:discount_approval:{checkoutId}`: approval status next to the legacy OTP map key
 * `{uid}_{store}_{counter}_{tab}`. Same TTL (PG_DISC_OTP_EX_VALUE).
 */
export const discountChallengeSchema = z
  .object({
    id: z.uuid(),
    checkoutId: z.uuid(),
    otpKey: z.string().min(7).max(100),
    binding: z.string().min(1).max(128),
    amount: z.string().regex(/^\d+\.\d{2}$/),
    productsTotal: z.string().regex(/^\d+\.\d{2}$/),
    expiresAt: z.number().int(),
    lastSentAt: z.number().int(),
    attempts: z.number().int().min(0),
    delivered: z.number().int().min(0),
    recipients: z.number().int().min(0),
    approvedBy: z.string().regex(/^[1-9]\d*$/).nullable(),
    approvedAt: z.number().int().nullable(),
  })
  .strict();
export type DiscountChallenge = z.infer<typeof discountChallengeSchema>;
/** Legacy value shape `{otp: [manager_id, pg_discount]}`, keyed by an HMAC instead of the OTP. */
export const discountOtpMapSchema = z.record(
  z.string().regex(/^[a-f0-9]{64}$/),
  z.tuple([z.number().int().positive(), z.string()]),
);
/** `pos:discount_approval_limit:{operatorId}` (table-disposition.md checkout/discounts). */
export const discountApprovalLimitSchema = z
  .object({
    lastSentAt: z.number().int(),
    windowStartedAt: z.number().int(),
    attempts: z.number().int().min(0),
  })
  .strict();
export type DiscountApprovalLimit = z.infer<typeof discountApprovalLimitSchema>;
export interface DiscountApprovalView {
  status: 'not-required' | 'required' | 'pending' | 'approved' | 'expired' | 'locked';
  amount: string;
  productsTotal: string;
  challengeId: string | null;
  expiresAt: number | null;
  retryAt: number | null;
  delivered: number;
  pending: number;
}
export interface DiscountApprovalEvidence {
  terms: DiscountTerms;
  approvalId: string | null;
  approvedBy: string | null;
}
export interface DiscountApprovals {
  permittedRoles: Principal['role'][];
  /** Old-PG apply role gate ("You do not have permission."); no gate for store PG or removal. */
  assertApplyPermission(user: Principal, kind: 'pg' | 'store', apply: boolean): void;
  describe(user: Principal, state: CheckoutState): Promise<DiscountApprovalView>;
  request(user: Principal, state: CheckoutState): Promise<DiscountApprovalView>;
  confirm(user: Principal, state: CheckoutState, code: string): Promise<DiscountApprovalView>;
  authorize(user: Principal, state: CheckoutState): Promise<DiscountApprovalEvidence>;
  /**
   * AjaxOrderView after `pos/order` succeeds (order/views.py:2764-2777): always writes
   * `orders.store_disc_pg_comment/reason`; when the combined comment is longer than one
   * character, inserts `store_pg_disc_addons` and sends the "PG Discount Used" email inline.
   */
  record(state: CheckoutState, orderId: string, evidence: DiscountApprovalEvidence): Promise<void>;
}
