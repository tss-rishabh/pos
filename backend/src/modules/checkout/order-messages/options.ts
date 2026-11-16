import { z } from 'zod';
import { orderMessageContract } from '../order-message-proof.js';
const text = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());
export function orderMessageOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      ORDER_SMS_DELIVERY_MODE: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.enum(['local', 'disabled']).default('disabled'),
      ),
      ORDER_SMS_DELIVERY_CONTRACT: text,
      POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT: text,
      POS_INVOICE_FEEDBACK_KEY_ID: text,
      POS_INVOICE_FEEDBACK_KEY: text,
      POS_INVOICE_FEEDBACK_URL: text,
      POS_INVOICE_FEEDBACK_TTL_SECONDS: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.coerce.number().int().min(60).max(2678400).optional(),
      ),
      TSS_JWT_HS256_KEY: text,
      TSS_JWT_HS512_KEY: text,
      TSS_POS_INVOICE_KEY: text,
      TSS_POS_CHECKOUT_PROJECTION_KEY: text,
      TSS_POS_ORDER_SMS_KEY: text,
    })
    .parse(env);
}
export type OrderMessageOptions = ReturnType<typeof orderMessageOptions>;
export const localOrderMessageContract = orderMessageContract;
