import { z } from 'zod';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { ImportFinancialState, SourceOrderReceipt } from '../financial-adapter-contracts.js';
import type { LegacyOrderImportPlan } from '../plans.js';
import {
  automaticCouponContract,
  complementaryContract,
  benefitError,
  automaticCouponReceiptSchema,
  posComplementaryReceiptSchema,
  couponActivationSchema,
  benefitReceiptHash,
  assertBenefitScope,
} from './contracts.js';
import { assertNativeCsvBenefits, readCsvBenefitDescriptors } from './native.js';
import type { BenefitCompositionInput, SealedBenefit } from './ownership.js';

export interface CsvBenefitProfileOptions {
  automaticCoupon?: typeof automaticCouponContract;
  complementary?: typeof complementaryContract;
  sourceProofKey: string;
}
export interface CsvBenefitProfileContext {
  state: ImportFinancialState;
  plan: LegacyOrderImportPlan;
  order: SourceOrderReceipt;
  /** The independent native membership verifier must also run in this transaction. */
  membership?: BenefitCompositionInput['membership'];
  confirmationHash?: string;
}
/** Root integration seam. It never activates source profiles, starts SQL, sends
 * provider requests, reads historical MySQL, or changes financial-stage nonces.
 * Caller retains original command→Store→Order→MUser/hold/session authority locks.
 */
export function csvBenefitProfileHooks(options: CsvBenefitProfileOptions) {
  const parsed = z
    .object({
      automaticCoupon: z.literal(automaticCouponContract).optional(),
      complementary: z.literal(complementaryContract).optional(),
      sourceProofKey: z.string().regex(/^[!-~]{32,4096}$/),
    })
    .strict()
    .safeParse(options);
  if (!parsed.success || (!options.automaticCoupon && !options.complementary)) throw benefitError();
  async function assert(
    tx: AdministrationTransaction,
    context: CsvBenefitProfileContext,
    phase: 'staged' | 'settled',
  ) {
    const values = await readCsvBenefitDescriptors(
      tx,
      context.state.scope.operationId,
      context.state.requestHash,
    );
    const coupon: SealedBenefit | undefined = values['coupon-benefit'],
      complementary: SealedBenefit | undefined = values['pos-complement'];
    if (
      (coupon && !options.automaticCoupon) ||
      (complementary && !options.complementary) ||
      (values['coupon-consume'] && !coupon)
    )
      throw benefitError();
    const activation = values['coupon-consume'];
    if (activation && !context.confirmationHash) throw benefitError();
    const result = await assertNativeCsvBenefits(tx, {
      ...context,
      sourceProofKey: options.sourceProofKey,
      coupon,
      complementary,
      phase,
      ...(activation
        ? { activation: { ...activation, confirmationHash: context.confirmationHash! } }
        : {}),
    });
    return {
      ...result,
      snapshot: {
        coupon: coupon ? { receipt: result.coupon, sourceReceiptHash: coupon.seal } : null,
        complementary: complementary
          ? { receipt: result.complementary, sourceReceiptHash: complementary.seal }
          : null,
        activation: activation
          ? {
              receipt: couponActivationSchema.parse(activation.value),
              sourceReceiptHash: activation.seal,
            }
          : null,
      },
    };
  }
  return {
    assertStaged: (tx: AdministrationTransaction, context: CsvBenefitProfileContext) =>
      assert(tx, context, 'staged'),
    assertSettled: (tx: AdministrationTransaction, context: CsvBenefitProfileContext) =>
      assert(tx, context, 'settled'),
  };
}

export { csvBenefitCompletionSchema, validateCsvBenefitCompletion } from './completion.js';

/** Authenticate a staged descriptor before saving; actual source writes/receipt
 * persistence belong to its existing transaction. Exported for bounded producer
 * ports, not a public route or a generic arbitrary receipt writer. */
export function validateCsvBenefitForPersistence(
  kind: 'coupon-benefit' | 'pos-complement' | 'coupon-consume',
  input: unknown,
  context: { state: ImportFinancialState; order: SourceOrderReceipt },
  key: string,
) {
  const receipt =
    kind === 'coupon-benefit'
      ? automaticCouponReceiptSchema.parse(input)
      : kind === 'pos-complement'
        ? posComplementaryReceiptSchema.parse(input)
        : couponActivationSchema.parse(input);
  assertBenefitScope(receipt.scope, context.state, context.order, key);
  return {
    receipt,
    seal: benefitReceiptHash(
      kind === 'coupon-benefit'
        ? 'coupon'
        : kind === 'pos-complement'
          ? 'complementary'
          : 'coupon-consumption',
      receipt,
      key,
    ),
  };
}
