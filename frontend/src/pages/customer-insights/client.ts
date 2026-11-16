import { z } from 'zod';
import { captureOperatorScope, request } from '../../api/client';
import { requireCachedOperatorSession } from '../../offline/operator-session';

export const customerProfileResponse = z
  .object({
    customerId: z.string().regex(/^[1-9]\d{0,19}$/),
    checkoutVersion: z.number().int().nonnegative(),
    etag: z.string().regex(/^[a-f0-9]{64}$/),
    editable: z.boolean(),
    profile: z
      .object({
        firstName: z.string().max(300),
        lastName: z.string().max(300),
        email: z.string().max(254),
        telephone: z.string().max(45),
        gender: z.enum(['M', 'F', 'O']).nullable(),
        birthday: z.iso.date().nullable(),
        anniversary: z.iso.date().nullable(),
        customerType: z.enum(['B2B', 'B2C']).nullable(),
        gstin: z.string().max(45).nullable(),
      })
      .strict(),
  })
  .strict();
export const profileChanges = z
  .object({
    birthday: z.iso
      .date()
      .refine((date) => date >= '1000-01-01')
      .optional(),
    anniversary: z.iso
      .date()
      .refine((date) => date >= '1000-01-01')
      .optional(),
    gender: z.enum(['M', 'F', 'O']).optional(),
    customerType: z.enum(['B2B', 'B2C']).optional(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^(?:[0-9A-Z]{15})?$/)
      .optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined));
export const profileAdjustmentInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    expectedEtag: z.string().regex(/^[a-f0-9]{64}$/),
    changes: profileChanges,
  })
  .strict();
export const profileAdjustmentResponse = z
  .object({
    adjustment: z
      .object({
        operationId: z.uuid(),
        customerId: z.string().regex(/^[1-9]\d{0,19}$/),
        checkoutVersion: z.number().int().nonnegative(),
        beforeEtag: z.string().regex(/^[a-f0-9]{64}$/),
        etag: z.string().regex(/^[a-f0-9]{64}$/),
        fields: z
          .array(z.enum(['birthday', 'anniversary', 'gender', 'customerType', 'gstin']))
          .min(1)
          .max(5),
        appliedAt: z.iso.datetime(),
      })
      .strict(),
    profile: customerProfileResponse,
  })
  .strict();
export type CustomerProfile = z.infer<typeof customerProfileResponse>;
export type ProfileAdjustmentInput = z.infer<typeof profileAdjustmentInput>;
export interface ProfileScope {
  operatorId: string;
  storeId: string;
  checkoutId: string;
  customerId: string;
}

export function customerWorkspaceBase(scope: ProfileScope) {
  return `/api/v1/stores/${encodeURIComponent(scope.storeId)}/checkout-sessions/${encodeURIComponent(scope.checkoutId)}`;
}
export async function customerWorkspaceRequest<T>(
  scope: ProfileScope,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
) {
  const signal = AbortSignal.any([
    captureOperatorScope(scope.operatorId),
    init.signal ?? AbortSignal.timeout(12000),
  ]);
  await requireCachedOperatorSession(scope.operatorId, scope.storeId, signal);
  const result = await request(
    path,
    { ...init, operatorId: scope.operatorId, signal, cache: 'no-store' },
    schema,
  );
  signal.throwIfAborted();
  await requireCachedOperatorSession(scope.operatorId, scope.storeId, signal);
  return result;
}
export async function readCustomerProfile(
  scope: ProfileScope,
  expectedVersion: number,
  signal: AbortSignal,
) {
  const result = await customerWorkspaceRequest(
    scope,
    customerWorkspaceBase(scope) + '/customer-profile',
    { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) },
    customerProfileResponse,
  );
  if (result.customerId !== scope.customerId || result.checkoutVersion !== expectedVersion)
    throw new Error('This sale changed. Refresh it before viewing customer details.');
  return result;
}
export async function profileAdjustment(
  scope: ProfileScope,
  input: ProfileAdjustmentInput,
  reconcile: boolean,
) {
  const validated = profileAdjustmentInput.parse(input);
  const result = await customerWorkspaceRequest(
    scope,
    customerWorkspaceBase(scope) +
      '/customer-profile-adjustments' +
      (reconcile ? '/' + encodeURIComponent(input.operationId) : ''),
    reconcile ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(validated) },
    profileAdjustmentResponse,
  );
  if (
    result.adjustment.operationId !== input.operationId ||
    result.adjustment.customerId !== scope.customerId ||
    result.profile.customerId !== scope.customerId ||
    result.adjustment.beforeEtag !== input.expectedEtag ||
    result.adjustment.checkoutVersion !== input.expectedVersion + 1 ||
    result.profile.checkoutVersion < result.adjustment.checkoutVersion ||
    (result.profile.checkoutVersion === result.adjustment.checkoutVersion &&
      result.profile.etag !== result.adjustment.etag) ||
    [...result.adjustment.fields].sort().join(',') !==
      Object.keys(validated.changes).sort().join(',')
  )
    throw new Error(
      'The saved customer update does not match this sale. Reload the sale before continuing.',
    );
  return result;
}
