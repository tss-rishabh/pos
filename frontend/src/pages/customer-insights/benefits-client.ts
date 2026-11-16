import { z } from 'zod';
import { customerWorkspaceBase, customerWorkspaceRequest, type ProfileScope } from './client';

export const customerBenefitsResponse = z
  .object({
    customerId: z.string().regex(/^[1-9]\d{0,19}$/),
    checkoutVersion: z.number().int().nonnegative(),
    membership: z
      .object({
        active: z.boolean(),
        expiry: z.string().max(32).nullable(),
        message: z.string().max(100),
      })
      .strict(),
    wallet: z
      .object({ money: z.string().regex(/^\d+\.\d{2}$/), points: z.string().regex(/^\d+\.\d{2}$/) })
      .strict(),
    app: z.object({ isAppUser: z.boolean(), discountEligible: z.boolean().nullable() }).strict(),
    activeGiftVoucherCount: z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
    customerSince: z.string().max(32).nullable(),
    fetchedAt: z.iso.datetime(),
  })
  .strict();
export async function readCustomerBenefits(
  scope: ProfileScope,
  expectedVersion: number,
  signal: AbortSignal,
) {
  const result = await customerWorkspaceRequest(
    scope,
    customerWorkspaceBase(scope) + '/customer-benefits',
    { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) },
    customerBenefitsResponse,
  );
  if (result.customerId !== scope.customerId || result.checkoutVersion !== expectedVersion)
    throw new Error('This sale changed. Reopen customer benefits.');
  return result;
}
