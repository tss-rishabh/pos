import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { amountSchema } from '../contracts.js';
import { cashReturnReason } from './intent-contracts.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const retainedCashReturnInput = z
  .object({
    operationId: z.uuid(),
    originalPaymentId: z.uuid(),
    counterId: identifier,
    snapshotHash: hash,
    cashReturnReceiptId: z.uuid(),
    returnedCash: amountSchema,
    confirmCashReturned: z.literal(true),
    confirmNoHandover: z.literal(true),
    reason: cashReturnReason,
  })
  .strict();
export const cashReturnClaimInput = z
  .object({
    original: retainedCashReturnInput,
    returnedBy: identifier,
    returnedAt: z.iso.datetime({ precision: 3 }),
    confirmAlreadyReturned: z.literal(true),
    evidenceId: z.uuid(),
  })
  .strict();
export const cashReturnClaimBody = z
  .object({
    id: z.uuid(),
    contract: z.literal('pos-retained-cash-return-v1'),
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    registeredBy: identifier,
    registeredAt: z.iso.datetime({ precision: 3 }),
    sessionHash: hash,
    input: cashReturnClaimInput,
    originalPaymentHash: hash,
    originalFundingAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    orderDate: z.iso.date(),
    businessTimezone: z.string().min(1).max(100),
    returnedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    businessDate: z.iso.date(),
  })
  .strict();
export type CashReturnClaimBody = z.infer<typeof cashReturnClaimBody>;
