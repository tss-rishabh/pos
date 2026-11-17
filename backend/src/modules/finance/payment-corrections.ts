import { z } from 'zod';
import { paymentCorrectionCashProjection } from '../checkout/payment-reversals/cash-projection.js';
import type { Databases } from '../../db/pools.js';
/** Retain this versioned key for reads even when new corrections are disabled. */
export function paymentCorrectionFinanceOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      publicationTable: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .regex(
            /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
          )
          .optional(),
      ),
      proofKey: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().min(32).max(4096).optional(),
      ),
    })
    .parse({
      proofKey: env.POS_PAYMENT_CORRECTION_PROOF_KEY_V1,
      publicationTable: env.BQ_PAYMENT_CORRECTION_PUBLICATIONS_TABLE,
    });
}
export type PaymentCorrectionFinanceOptions = ReturnType<typeof paymentCorrectionFinanceOptions>;
export async function currentPaymentCorrectionCash(
  db: Pick<ReturnType<Databases['get']>, 'select'>,
  storeIds: string[],
  from: string,
  to: string,
  options: PaymentCorrectionFinanceOptions,
) {
  // Empty native partitions are explicitly read. Once a managed order exists,
  // absent/rotated proof keys fail instead of reverting to mutable source cash.
  return paymentCorrectionCashProjection(db, { storeIds, from, to }, options.proofKey ?? '');
}
