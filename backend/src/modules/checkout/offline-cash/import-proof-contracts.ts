import { z } from 'zod';
import { cashCents, cashHash, cashIdentifier, cashSignature, cashTimestamp } from './contracts.js';
import { refundAllocationContract, refundSourcePatchHash } from '../refund-allocation.js';

export const cashImportProofDataSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('pos-offline-cash-import-v1'),
    receiptId: z.uuid(),
    authorizationId: z.uuid(),
    receiptHash: cashHash,
    orderId: cashIdentifier,
    operatorId: cashIdentifier,
    customerId: cashIdentifier,
    storeId: cashIdentifier,
    counterId: cashIdentifier,
    businessDate: z.iso.date(),
    receiptNumber: z.string().regex(/^OC-[A-F0-9]{32}-\d{4}$/),
    payableCents: cashCents,
    cashReceivedCents: cashCents,
    changeCents: cashCents,
    finalizedAt: cashTimestamp,
    orderCreatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    headerHash: cashHash,
    lineItemsEnabled: z.boolean(),
    lines: z
      .array(
        z
          .object({
            hasProductId: cashIdentifier,
            productId: cashIdentifier,
            quantity: z.number().int().positive().max(99),
            priceHash: cashHash,
          })
          .strict(),
      )
      .min(1)
      .max(9900),
    stock: z
      .array(
        z
          .object({
            productId: cashIdentifier,
            quantity: z.number().int().positive().max(99),
            beforeAvailable: z.number().int().nonnegative(),
            afterAvailable: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    stockContract: z.literal('pos-stock-projection-70b801-v1'),
    sourceApiCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
    sourcePaymentsCommit: z.literal('434f3e438d1cb48c64e5723222c6efda506db571'),
    refundAllocationContract: z.literal(refundAllocationContract),
    refundSourcePatchHash: z.literal(refundSourcePatchHash),
  })
  .strict()
  .superRefine((proof, context) => {
    const quantities = new Map<string, number>(),
      stockIds = new Set(proof.stock.map((stock) => stock.productId));
    for (const line of proof.lines)
      quantities.set(line.productId, (quantities.get(line.productId) || 0) + line.quantity);
    if (
      proof.payableCents <= 0 ||
      proof.cashReceivedCents - proof.changeCents !== proof.payableCents ||
      proof.orderCreatedAt.slice(0, 10) !== proof.businessDate
    )
      context.addIssue({
        code: 'custom',
        message: 'The sealed cash payment or business date is inconsistent.',
      });
    if (
      new Set(proof.lines.map((line) => line.hasProductId)).size !== proof.lines.length ||
      new Set(proof.stock.map((line) => line.productId)).size !== proof.stock.length
    )
      context.addIssue({
        code: 'custom',
        message: 'The sealed cash projection contains duplicate lines.',
      });
    if (proof.lineItemsEnabled && proof.lines.some((line) => line.quantity !== 1))
      context.addIssue({ code: 'custom', message: 'The sealed cash line mode is inconsistent.' });
    if (!proof.lineItemsEnabled && quantities.size !== proof.lines.length)
      context.addIssue({
        code: 'custom',
        message: 'The sealed cash quantity mode is inconsistent.',
      });
    for (const stock of proof.stock) {
      if (
        stock.beforeAvailable - stock.quantity !== stock.afterAvailable ||
        quantities.get(stock.productId) !== stock.quantity
      )
        context.addIssue({
          code: 'custom',
          message: 'The sealed stock transition is inconsistent.',
        });
    }
    if ([...quantities.keys()].some((productId) => !stockIds.has(productId)))
      context.addIssue({ code: 'custom', message: 'A sealed line has no stock transition.' });
  });
export const signedCashImportProofSchema = z
  .object({ proof: cashImportProofDataSchema, keyId: cashHash, signature: cashSignature })
  .strict();
export type CashImportProofData = z.infer<typeof cashImportProofDataSchema>;
export type SignedCashImportProof = z.infer<typeof signedCashImportProofSchema>;
