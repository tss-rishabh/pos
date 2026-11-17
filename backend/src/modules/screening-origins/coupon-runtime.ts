import type { GenerationDependencies } from '../legacy-order-imports/benefit-profile/history-generation-read.js';
import { readGenerationOptions } from '../legacy-order-imports/benefit-profile/history-generation-options.js';
import { originError } from './contracts.js';
import { originCouponHistoryContract } from './coupon-contracts.js';
import { originCouponHistory, type OriginCouponDemandPort } from './coupon-history.js';
/** Pure opt-in loader. Shared generic CSV-named views describe source predicates,
 * never a CSV operation or source/operator authority. Reader credentials remain
 * the explicitly injected bounded read-only SDK port owned by the private CLI. */
export function originCouponRuntime(
  env: NodeJS.ProcessEnv,
  authority: { originKey: string; sourceKey: string; publicationKey: string },
  dependencies: GenerationDependencies & { demand?: OriginCouponDemandPort } = {},
) {
  const selector = env.POS_SCREENING_ORIGIN_COUPON_HISTORY_CONTRACT;
  if (!selector) return undefined;
  if (selector !== originCouponHistoryContract)
    throw originError('SCREENING_ORIGIN_COUPON_CONFIGURATION');
  return originCouponHistory(readGenerationOptions(env), authority, dependencies);
}
