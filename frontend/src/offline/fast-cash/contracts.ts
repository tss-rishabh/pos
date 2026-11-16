import { z } from 'zod';
import { confirmedPaymentSchema } from '../../pages/checkout/receipts';
const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const fastSessionSchema = z.object({
  id: z.literal('current'),
  expiresAt: z.number().int().safe().positive(),
  user: z.object({
    id,
    name: z.string(),
    email: z.string(),
    role: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    userType: z.union([z.literal(1), z.literal(2)]),
    storeIds: z.array(id),
  }),
});
export const fastAmount = z.string().regex(/^\d{1,8}\.\d{2}$/);
export const fastCashCommandSchema = z
  .object({
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    ownerId: id,
    storeId: id,
    counterId: id,
    draftId: z.uuid(),
    draftVersion: z.number().int().nonnegative(),
    checkoutId: z.uuid(),
    checkoutVersion: z.number().int().nonnegative(),
    quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
    noteHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    payable: fastAmount,
    cashReceived: fastAmount,
    submissionId: z.uuid(),
    paymentId: z.uuid(),
    orderId: id.nullable(),
    state: z.enum([
      'prepared',
      'submitting',
      'order-uncertain',
      'order-ready',
      'paying',
      'payment-uncertain',
      'paid',
      'stopped',
    ]),
    claimId: z.uuid().nullable(),
    claimedAt: z.number().int().nonnegative().nullable(),
    orderAttempts: z.number().int().nonnegative(),
    paymentAttempts: z.number().int().nonnegative(),
    receipt: confirmedPaymentSchema.nullable(),
    errorCode: z.string().max(96).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type FastCashCommand = z.infer<typeof fastCashCommandSchema>;
export interface FastCashOwner {
  ownerId: string;
  storeId: string;
  counterId: string;
  commandId: string;
}
export const cashPaymentSchema = z
  .object({
    id: z.uuid(),
    operatorId: id,
    storeId: id,
    counterId: id,
    orderId: id,
    channel: z.literal('cash'),
    cashAmount: fastAmount,
    onlineAmount: z.literal('0.00'),
    cashReceived: fastAmount,
    transactionId: z.string(),
    checkoutNote: z
      .object({ checkoutId: z.uuid(), noteHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .nullable()
      .optional(),
    status: z.enum([
      'dispatching',
      'pending',
      'uncertain',
      'cancelling',
      'paid',
      'failed',
      'cancelled',
    ]),
    errorCode: z.string().nullable(),
  })
  .passthrough();
export type CashPayment = z.infer<typeof cashPaymentSchema>;
export function fastCents(value: string): bigint {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value))
    throw new Error('Enter an exact non-negative amount with up to two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export const fastDecimal = (cents: bigint) =>
  `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
export function cashIntentAmounts(total: string, received: string) {
  const payable = fastDecimal(fastCents(total)),
    entered = received.trim() ? fastCents(received.trim()) : 0n;
  if (fastCents(payable) === 0n && entered !== 0n)
    throw new Error('This prepaid sale requires no cash. Clear the cash received amount.');
  const cashReceived = fastDecimal(entered === 0n ? fastCents(payable) : entered);
  if (fastCents(cashReceived) < fastCents(payable))
    throw new Error('Cash received must cover the exact quoted payable.');
  return { payable, cashReceived };
}
