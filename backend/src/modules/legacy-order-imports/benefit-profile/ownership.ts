import { minorUnits } from '../../../domain/money.js';
import type { ImportFinancialState, SourceOrderReceipt } from '../financial-adapter-contracts.js';
import type { LegacyOrderImportPlan } from '../plans.js';
import { verifyCsvMembershipDescriptor } from '../membership-profile/domain.js';
import {
  automaticCouponReceiptSchema,
  posComplementaryReceiptSchema,
  assertBenefitScope,
  benefitError,
  verifyBenefitSeal,
} from './contracts.js';

export interface SealedBenefit {
  value: unknown;
  seal: string;
}
export interface BenefitCompositionInput {
  state: ImportFinancialState;
  plan: LegacyOrderImportPlan;
  order: SourceOrderReceipt;
  sourceProofKey: string;
  complementary?: SealedBenefit;
  coupon?: SealedBenefit;
  membership?: SealedBenefit & {
    membershipProofKey: string;
    productIds: readonly string[];
    freeProductId: string;
  };
}
/** Ownership is exhaustive and HP-ID-specific. A scalar extra quantity is never admission evidence. */
export function verifyCsvBenefitComposition(input: BenefitCompositionInput) {
  const { state, plan, order, sourceProofKey } = input;
  if (
    order.method !== (plan.kind === 'offline' ? 14 : 15) ||
    plan.storeId !== state.scope.storeId ||
    plan.createdAt !== order.createdAt ||
    new Set(plan.lines.map((row) => row.productId)).size !== plan.lines.length ||
    new Set(order.lines.map((row) => row.id)).size !== order.lines.length
  )
    throw benefitError();
  const actual = new Map(order.lines.map((row) => [row.id, row]));
  const owners = new Map<string, 'original-plan' | 'membership' | 'pos-complementary'>();
  const selections = new Set<string>();
  let complementary = null;
  if (input.complementary) {
    const parsed = posComplementaryReceiptSchema.safeParse(input.complementary.value);
    if (!parsed.success) throw benefitError();
    complementary = parsed.data;
    verifyBenefitSeal('complementary', complementary, input.complementary.seal, sourceProofKey);
    assertBenefitScope(complementary.scope, state, order, sourceProofKey);
    for (const selected of complementary.selections) {
      const declared = plan.lines.find((row) => row.productId === selected.productId);
      const hp = actual.get(selected.line.id);
      if (
        !declared ||
        declared.quantity !== selected.declaredQuantity ||
        declared.unitPrice !== selected.declaredUnitPrice ||
        JSON.stringify(declared.sourceRows) !== JSON.stringify(selected.sourceRows) ||
        !hp ||
        hp.productId !== selected.productId ||
        hp.quantity !== 1 ||
        hp.inputHash !== selected.line.inputHash ||
        selected.priceRule !==
          (order.lineItemsEnabled ? 'source-zero-per-unit' : 'source-base-aggregate') ||
        selected.line.price !== (order.lineItemsEnabled ? '0.00' : selected.catalogBasePrice) ||
        (order.lineItemsEnabled && selected.line.refundable !== '0.00') ||
        order.lines.filter((row) => row.productId === selected.productId).length !== 1 ||
        input.membership?.productIds.includes(selected.productId)
      )
        throw benefitError();
      owners.set(hp.id, 'pos-complementary');
      selections.add(selected.productId);
    }
  }
  const ordinaryPlan = {
    ...plan,
    lines: plan.lines.filter((row) => !selections.has(row.productId)),
  };
  const ordinaryOrder = {
    ...order,
    lines: order.lines.filter((row) => !selections.has(row.productId)),
  };
  let membership = null;
  if (input.membership) {
    // The existing independently sealed membership verifier still owns membership
    // entitlement/causality. Its view removes ONLY separately proved POS selections;
    // full plan/header/line hashes remain unchanged and are checked by both profiles.
    membership = verifyCsvMembershipDescriptor({
      state,
      plan: ordinaryPlan,
      order: ordinaryOrder,
      value: input.membership.value,
      seal: input.membership.seal,
      sourceProofKey,
      membershipProofKey: input.membership.membershipProofKey,
      productIds: input.membership.productIds,
      freeProductId: input.membership.freeProductId,
    }).receipt;
    for (const hp of membership.memberLines) {
      if (owners.has(hp.id)) throw benefitError();
      owners.set(hp.id, 'membership');
    }
  }
  const expected = new Map(ordinaryPlan.lines.map((row) => [row.productId, row.quantity]));
  for (const row of membership?.additionalLines ?? []) {
    if (expected.has(row.productId)) throw benefitError();
    expected.set(row.productId, row.quantity);
  }
  const counts = new Map<string, number>();
  for (const hp of ordinaryOrder.lines) {
    if (!expected.has(hp.productId)) throw benefitError();
    counts.set(hp.productId, (counts.get(hp.productId) ?? 0) + hp.quantity);
    if (!owners.has(hp.id)) owners.set(hp.id, 'original-plan');
  }
  if (
    expected.size !== counts.size ||
    [...expected].some(([id, qty]) => counts.get(id) !== qty) ||
    owners.size !== order.lines.length
  )
    throw benefitError();
  let coupon = null;
  if (input.coupon) {
    const parsed = automaticCouponReceiptSchema.safeParse(input.coupon.value);
    if (!parsed.success) throw benefitError();
    coupon = parsed.data;
    verifyBenefitSeal('coupon', coupon, input.coupon.seal, sourceProofKey);
    assertBenefitScope(coupon.scope, state, order, sourceProofKey);
    if (
      coupon.allocations.length !== actual.size ||
      coupon.refundAllocationContract !== order.refundAllocationContract ||
      coupon.refundSourcePatchHash !== order.refundSourcePatchHash ||
      coupon.allocations.some((row) => {
        const hp = actual.get(row.id);
        return (
          !hp ||
          hp.productId !== row.productId ||
          hp.quantity !== row.quantity ||
          hp.inputHash !== row.inputHash ||
          (owners.get(row.id) === 'pos-complementary' &&
            (row.discount !== '0.00' ||
              row.refundable !==
                complementary?.selections.find((selected) => selected.line.id === row.id)?.line
                  .refundable))
        );
      })
    )
      throw benefitError();
    // Shopify header intentionally has no coupon ID; its custom discount takes
    // the original header path. Do not turn this into coupon consumption.
    if (
      plan.kind === 'shopify' &&
      coupon.headerCouponAmount !==
        (minorUnits(plan.discountAmount) > 0n ? coupon.cartCouponDiscount : '0.00')
    )
      throw benefitError();
    if (
      plan.kind === 'offline' &&
      coupon.allocations.reduce((sum, row) => sum + minorUnits(row.discount), 0n) !==
        minorUnits(coupon.cartCouponDiscount)
    )
      throw benefitError();
  }
  return {
    coupon,
    complementary,
    membership,
    ownership: order.lines.map((line) => ({ ...line, owner: owners.get(line.id)! })),
    /** Shopify source reduces exactly the CSV plan, even a selected freebie's declared qty. */
    stock:
      plan.kind === 'shopify'
        ? {
            kind: 'original-plan' as const,
            lines: plan.lines.map((row) => ({ productId: row.productId, quantity: row.quantity })),
          }
        : {
            kind: 'actual-hp' as const,
            lines: order.lines.map((row) => ({
              id: row.id,
              productId: row.productId,
              quantity: row.quantity,
            })),
          },
    membershipAdmissionView: { plan: ordinaryPlan, order: ordinaryOrder },
  };
}
