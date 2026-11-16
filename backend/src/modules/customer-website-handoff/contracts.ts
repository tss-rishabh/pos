import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
export const customerWebsiteHandoffContract = 'pos-customer-website-handoff-v1';
export const handoffIdentifier = identifier.refine(
  (value) => BigInt(value) <= 9223372036854775807n,
);
export const websiteHandoffScope = z
  .object({ storeId: handoffIdentifier, checkoutId: z.uuid() })
  .strict();
export type WebsiteHandoffScope = z.infer<typeof websiteHandoffScope>;
export const websiteHandoffIssue = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().min(0).max(2147483647),
    customerConsent: z.literal(true),
  })
  .strict();
export type WebsiteHandoffIssue = z.infer<typeof websiteHandoffIssue>;
export const websiteHandoffRedemption = z
  .object({
    operationId: z.uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type WebsiteHandoffRedemption = z.infer<typeof websiteHandoffRedemption>;
export const websiteHandoffSession = z
  .object({ id: z.uuid(), expiresAt: z.number().int().positive().safe() })
  .strict();
export type WebsiteHandoffSession = z.infer<typeof websiteHandoffSession>;
export const websiteHandoffReceipt = z
  .object({
    contract: z.literal(customerWebsiteHandoffContract),
    receiptId: z.uuid(),
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    checkoutVersion: z.number().int().nonnegative(),
    customerId: handoffIdentifier,
    operatorId: handoffIdentifier,
    operatorCustomerId: handoffIdentifier,
    storeId: handoffIdentifier,
    counterId: handoffIdentifier,
    sessionExpiresAt: z.number().int().positive().safe(),
  })
  .strict();
