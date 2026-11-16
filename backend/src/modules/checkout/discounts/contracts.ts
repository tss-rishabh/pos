import type { Principal } from '../../../domain/access.js';
import type { CheckoutState } from '../contracts.js';
import type { DiscountTerms } from './policy.js';

export interface DiscountChallenge {
  id: string;
  binding: string;
  amount: string;
  productsTotal: string;
  expiresAt: number;
  lastSentAt: number;
  attempts: number;
  codes: { managerId: string; digest: string }[];
  approvedBy: string | null;
  approvedAt: number | null;
}
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
  describe(user: Principal, state: CheckoutState): Promise<DiscountApprovalView>;
  request(user: Principal, state: CheckoutState): Promise<DiscountApprovalView>;
  confirm(user: Principal, state: CheckoutState, code: string): Promise<DiscountApprovalView>;
  authorize(user: Principal, state: CheckoutState): Promise<DiscountApprovalEvidence>;
  record(state: CheckoutState, orderId: string, evidence: DiscountApprovalEvidence): Promise<void>;
}
