import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const customerBenefits = z
  .object({
    customerId: identifier,
    checkoutVersion: z.number().int().nonnegative(),
    membership: z
      .object({
        active: z.boolean(),
        expiry: z.string().max(32).nullable(),
        message: z.string().max(100),
      })
      .strict(),
    wallet: z
      .object({
        money: z.string().regex(/^\d+\.\d{2}$/),
        points: z.string().regex(/^\d+\.\d{2}$/),
      })
      .strict(),
    app: z
      .object({
        isAppUser: z.boolean(),
        discountEligible: z.boolean().nullable(),
      })
      .strict(),
    activeGiftVoucherCount: z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
    customerSince: z.string().max(32).nullable(),
    fetchedAt: z.iso.datetime(),
  })
  .strict();
export type CustomerBenefits = z.infer<typeof customerBenefits>;
