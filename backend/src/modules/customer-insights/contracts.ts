import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const customerProfileScope = z
  .object({ storeId: identifier, checkoutId: z.uuid() })
  .strict();
export const customerProfileSchema = z
  .object({
    customerId: identifier,
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
export type CustomerProfile = z.infer<typeof customerProfileSchema>;
export type CustomerProfileScope = z.infer<typeof customerProfileScope>;

const propertyDate = z.iso
  .date()
  .refine((value) => value >= '1000-01-01', 'Use a valid calendar date.');
export const customerProfileChanges = z
  .object({
    birthday: propertyDate.optional(),
    anniversary: propertyDate.optional(),
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
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Choose a profile field to update.',
  );
export const customerProfileAdjustmentInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    expectedEtag: z.string().regex(/^[a-f0-9]{64}$/),
    changes: customerProfileChanges,
  })
  .strict();
export const customerProfileField = z.enum([
  'birthday',
  'anniversary',
  'gender',
  'customerType',
  'gstin',
]);
export const customerProfileAdjustmentReceipt = z
  .object({
    operationId: z.uuid(),
    customerId: identifier,
    checkoutVersion: z.number().int().nonnegative(),
    beforeEtag: z.string().regex(/^[a-f0-9]{64}$/),
    etag: z.string().regex(/^[a-f0-9]{64}$/),
    fields: z.array(customerProfileField).min(1).max(5),
    appliedAt: z.iso.datetime(),
  })
  .strict();
export const customerProfileAdjustmentResponse = z
  .object({
    adjustment: customerProfileAdjustmentReceipt,
    profile: customerProfileSchema,
  })
  .strict();
export type CustomerProfileAdjustmentInput = z.infer<typeof customerProfileAdjustmentInput>;
export type CustomerProfileAdjustmentReceipt = z.infer<typeof customerProfileAdjustmentReceipt>;
