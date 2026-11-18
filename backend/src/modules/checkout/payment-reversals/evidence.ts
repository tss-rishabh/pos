import type { AdministrationTransaction } from '../../administration/checkins.js';

/**
 * @deprecated The correction overlay is deleted (`pos_rewrite_payment_reversals`,
 * `pos_rewrite_payment_correction_*`). Payments ignore this port; it remains only so the
 * lead-owned registrations in app.ts and checkout/routes.ts keep compiling until removed.
 */
export interface PaymentCorrectionPort {
  readonly deprecated: true;
}
export type PaymentCorrectionTransaction = AdministrationTransaction;
export function paymentCorrectionEvidence(_secret?: string): PaymentCorrectionPort {
  return { deprecated: true };
}
