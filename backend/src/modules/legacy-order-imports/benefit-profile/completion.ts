import { z } from 'zod';
import type { ImportFinancialState, SourceOrderReceipt } from '../financial-adapter-contracts.js';
import {
  automaticCouponReceiptSchema,
  posComplementaryReceiptSchema,
  couponActivationSchema,
  benefitError,
} from './contracts.js';

export const csvBenefitCompletionSchema = z
  .object({
    coupon: z
      .object({
        receipt: automaticCouponReceiptSchema,
        sourceReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    complementary: z
      .object({
        receipt: posComplementaryReceiptSchema,
        sourceReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    activation: z
      .object({
        receipt: couponActivationSchema,
        sourceReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 750000);
type CompletionContext = Pick<
  ImportFinancialState,
  'scope' | 'authority' | 'planHash' | 'requestHash' | 'benefitContracts'
> & { order: SourceOrderReceipt };

/** Scope/ownership validation for a staged benefit snapshot. Full immutable
 * financial completion additionally requires the confirmation checks below. */
export function validateCsvBenefitCompletion(value: unknown, context: CompletionContext) {
  const parsed = csvBenefitCompletionSchema.safeParse(value);
  if (!parsed.success) throw benefitError();
  const result = parsed.data,
    lines = new Map(context.order.lines.map((row) => [row.id, row]));
  if (lines.size !== context.order.lines.length || (result.activation && !result.coupon))
    throw benefitError();
  for (const descriptor of [result.coupon, result.complementary, result.activation]) {
    if (!descriptor) continue;
    const scope = descriptor.receipt.scope;
    if (
      scope.operationId !== context.scope.operationId ||
      scope.actorId !== context.scope.actorId ||
      scope.storeId !== context.scope.storeId ||
      scope.counterId !== context.scope.counterId ||
      scope.requestHash !== context.requestHash ||
      scope.planHash !== context.planHash ||
      scope.orderId !== context.order.orderId ||
      scope.customerId !== context.authority.customerId ||
      scope.namespace !== context.order.namespace ||
      scope.namespace !== 'pos-import-v1:' + scope.operationId ||
      scope.method !== context.order.method ||
      scope.headerHash !== context.order.headerHash ||
      scope.lineHash !== context.order.lineHash
    )
      throw benefitError();
  }
  for (const row of result.coupon?.receipt.allocations ?? []) {
    const hp = lines.get(row.id);
    if (
      !hp ||
      hp.productId !== row.productId ||
      hp.quantity !== row.quantity ||
      hp.inputHash !== row.inputHash
    )
      throw benefitError();
  }
  if (result.coupon && result.coupon.receipt.allocations.length !== lines.size)
    throw benefitError();
  for (const row of result.complementary?.receipt.selections ?? []) {
    const hp = lines.get(row.line.id);
    if (
      !hp ||
      hp.productId !== row.productId ||
      hp.quantity !== 1 ||
      hp.inputHash !== row.line.inputHash
    )
      throw benefitError();
  }
  if (
    result.activation &&
    (result.activation.receipt.couponId !== result.coupon!.receipt.couponId ||
      result.activation.receipt.stagedReceiptHash !== result.coupon!.sourceReceiptHash)
  )
    throw benefitError();
  return result;
}

/** No defaults: omission on old ordinary documents remains omission for HMACs. */
export const csvFinancialBenefitSnapshotSchema = csvBenefitCompletionSchema.safeExtend({
  confirmationHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type CsvFinancialBenefitSnapshot = z.infer<typeof csvFinancialBenefitSnapshotSchema>;

/** Invoke only AFTER authenticating the enclosing immutable financial HMAC.
 * No current source key, contact, coupon, counter, Redis or entitlement read. */
export function validateCsvFinancialBenefitSnapshot(
  value: unknown,
  context: CompletionContext & { kind: 'offline' | 'shopify' },
) {
  const parsed = csvFinancialBenefitSnapshotSchema.safeParse(value);
  if (!parsed.success) throw benefitError();
  const { confirmationHash, ...base } = parsed.data,
    result = validateCsvBenefitCompletion(base, context),
    offline = context.kind === 'offline';
  if (
    (context.benefitContracts !== undefined &&
      ((result.coupon && !context.benefitContracts.automaticCoupon) ||
        (result.complementary && !context.benefitContracts.complementary))) ||
    (!result.coupon && !result.complementary) ||
    context.order.method !== (offline ? 14 : 15) ||
    (offline ? confirmationHash === null : confirmationHash !== null) ||
    Boolean(result.activation) !== (offline && result.coupon !== null)
  )
    throw benefitError();
  if (result.activation && result.coupon) {
    const activation = result.activation.receipt,
      coupon = result.coupon.receipt;
    if (
      activation.sourceConfirmationHash !== confirmationHash ||
      JSON.stringify(activation.scope) !== JSON.stringify(coupon.scope) ||
      activation.changes.length !== coupon.couponUsersBefore.length ||
      activation.changes.some(
        (change) =>
          coupon.couponUsersBefore.find((row) => row.id === change.id)?.used !== change.before,
      )
    )
      throw benefitError();
  }
  return parsed.data;
}
