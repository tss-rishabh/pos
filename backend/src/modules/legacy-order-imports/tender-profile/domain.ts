import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';

const currency = z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/);
const nativeAmount = z
  .string()
  .max(48)
  .regex(/^\d{1,11}(?:\.\d{1,30})?$/)
  .refine((value) => new Decimal(value).lte('9999999999.99'));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const tenderRowsSchema = z
  .array(
    z.strictObject({
      productId: identifier,
      quantity: z.number().int().min(1).max(999),
      unitPrice: currency.refine((value) => new Decimal(value).gt(0)),
    }),
  )
  .min(1)
  .max(999);
export const nativeTenderFactsSchema = z.strictObject({
  orderId: identifier,
  headerHash: digest,
  lineHash: digest,
  counterHash: digest,
  payable: currency,
  roundingOff: currency,
  couponDiscount: currency,
  approvedRefundTotal: currency,
  counter: z.strictObject({
    cash: nativeAmount,
    received: nativeAmount,
    online: nativeAmount,
    manualOther: nativeAmount,
  }),
});
export type NativeTenderFacts = z.infer<typeof nativeTenderFactsSchema>;
export const csvTenderEvidenceSchema = z.strictObject({
  operationId: z.uuid(),
  planHash: digest,
  sourceUnitSequenceHash: digest,
  rows: tenderRowsSchema,
  mode: z.enum(['cash', 'manual-other']),
  declaredTender: currency,
  originalSourceTenderRaw: nativeAmount,
  native: nativeTenderFactsSchema,
});
export type CsvTenderEvidence = z.infer<typeof csvTenderEvidenceSchema>;
export function sourceTenderUnitSequenceHash(rows: z.infer<typeof tenderRowsSchema>) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        tenderRowsSchema.parse(rows).map((row) => [row.productId, row.quantity, row.unitPrice]),
      ),
    )
    .digest('hex');
}
function invalid(): never {
  throw new AppError(
    409,
    'CSV_TENDER_EVIDENCE_INVALID',
    'The original tender needs reconciliation. No payment or refund was dispatched.',
  );
}
const fixed = (value: Decimal) => value.toFixed(2, Decimal.ROUND_HALF_UP);
/** Review-only candidate. This does not authorize a financial mutation and has
 * no runtime registrar/config switch. The monetary policy remains unselected. */
export function reviewOriginalCsvTender(input: unknown) {
  const value = csvTenderEvidenceSchema.parse(input),
    facts = value.native;
  const totalUnits = value.rows.reduce((sum, row) => sum + row.quantity, 0);
  const declared = value.rows.reduce(
    (sum, row) => sum.plus(new Decimal(row.unitPrice).mul(row.quantity)),
    new Decimal(0),
  );
  const raw = new Decimal(value.originalSourceTenderRaw),
    cash = new Decimal(facts.counter.cash),
    received = new Decimal(facts.counter.received),
    online = new Decimal(facts.counter.online),
    manual = new Decimal(facts.counter.manualOther),
    payable = new Decimal(facts.payable);
  if (
    totalUnits > 999 ||
    !declared.eq(value.declaredTender) ||
    fixed(raw) !== value.declaredTender ||
    sourceTenderUnitSequenceHash(value.rows) !== value.sourceUnitSequenceHash ||
    !cash.eq(received) ||
    !online.isZero() ||
    (value.mode === 'cash'
      ? !manual.isZero() || !cash.eq(raw)
      : !cash.isZero() || !received.isZero() || !manual.eq(raw)) ||
    !new Decimal(facts.approvedRefundTotal).eq(payable)
  )
    invalid();
  const difference = declared.minus(payable),
    roundedCash = fixed(cash),
    roundedManual = fixed(manual);
  return {
    contract: 'pos-csv-dual-tender-review-v1' as const,
    financiallyExecutable: false as const,
    operationId: value.operationId,
    orderId: facts.orderId,
    planHash: value.planHash,
    evidence: {
      headerHash: facts.headerHash,
      lineHash: facts.lineHash,
      counterHash: facts.counterHash,
      sourceUnitSequenceHash: value.sourceUnitSequenceHash,
    },
    classification: difference.gt(0)
      ? 'over-collected'
      : difference.lt(0)
        ? 'under-collected'
        : 'balanced',
    amounts: {
      declaredTender: value.declaredTender,
      sourcePayable: facts.payable,
      sourceRoundingOff: facts.roundingOff,
      sourceCouponDiscount: facts.couponDiscount,
      approvedRefundTotal: facts.approvedRefundTotal,
      unexplainedDifference: fixed(difference),
      nativeFloatDrift: raw.minus(declared).toFixed(),
    },
    // Preserve the literal original recorded tender fields, including its native
    // representation. No change, provider collection or cash-out is synthesized.
    proposedCounterFields: {
      offline_payment: facts.counter.cash,
      offline_payment_recieved: facts.counter.received,
      online_payment: facts.counter.online,
      online_other_payment: facts.counter.manualOther,
    },
    sourceDsr: { cash: roundedCash, onlineResidual: fixed(payable.minus(cash)) },
    candidateDsr: {
      cash: roundedCash,
      online: roundedManual,
      unallocatedSurplus: fixed(Decimal.max(difference, 0)),
      unallocatedShortfall: fixed(Decimal.max(difference.negated(), 0)),
    },
    orderHeaderAction: 'preserve' as const,
    refundAllocationAction: 'preserve' as const,
    providerAction: 'none' as const,
    cashOutAction: 'none' as const,
    change: '0.00',
    reconciliationRequired: !difference.isZero(),
  };
}
