import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import {
  cashConflictSchema,
  cashHash,
  type CashAuthorization,
  type CashReceipt,
} from './contracts.js';

export const cashImportApprovalInputSchema = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
    orderCreatedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      .optional(),
  })
  .strict();
export const cashImportApprovalDetailsSchema = z
  .object({
    version: z.literal(1),
    receiptHash: cashHash,
    authorizationId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    orderCreatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    acknowledgedConflicts: z.array(cashConflictSchema).max(20),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type CashImportApprovalInput = z.infer<typeof cashImportApprovalInputSchema>;
export const cashOrderImportInputSchema = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    approvalId: z.uuid().optional(),
  })
  .strict();
export type CashOrderImportInput = z.infer<typeof cashOrderImportInputSchema>;

const attributionRequired = () =>
  new AppError(
    409,
    'OFFLINE_CASH_CLOCK_ATTRIBUTION_REQUIRED',
    'A store manager must attribute this receipt to a time inside its signed business day. The original cash receipt is preserved.',
  );

export function offlineCashOrderTimestamp(
  authorization: CashAuthorization,
  receipt: CashReceipt,
  zone: string,
  attributed?: string,
) {
  if (attributed !== undefined) {
    try {
      const plain = Temporal.PlainDateTime.from(attributed.replace(' ', 'T'));
      const instant = plain.toZonedDateTime(zone, { disambiguation: 'reject' });
      if (
        plain.toPlainDate().toString() !== authorization.businessDate ||
        instant.epochMilliseconds < authorization.issuedAt ||
        instant.epochMilliseconds > authorization.expiresAt
      )
        throw attributionRequired();
      return plain.toString({ smallestUnit: 'second' }).replace('T', ' ');
    } catch {
      throw attributionRequired();
    }
  }
  try {
    const instant = Temporal.Instant.fromEpochMilliseconds(receipt.completedAt).toZonedDateTimeISO(
      zone,
    );
    if (
      receipt.completedAt < authorization.issuedAt ||
      receipt.completedAt > authorization.expiresAt ||
      instant.toPlainDate().toString() !== authorization.businessDate
    )
      throw attributionRequired();
    return instant.toPlainDateTime().toString({ smallestUnit: 'second' }).replace('T', ' ');
  } catch {
    throw attributionRequired();
  }
}
