import { originError } from './contracts.js';
import { originHistoryKeys } from './history-contracts.js';
import { originCouponDemandContract, originCouponDemandJournal } from './coupon-demands.js';
import {
  originCouponControlsHttp,
  originCouponGenerationWorker,
  type OriginCouponControlsPort,
} from './coupon-generation-worker.js';
import type { Databases } from '../../db/pools.js';
import type { couponGenerationPublisher } from '../legacy-order-imports/benefit-profile/history-generation-publisher.js';
/** Worker-only composition. Root invokes drain from the existing runnable
 * generic publisher cycle, before its immutable-job worker. No additional
 * reader credential, financial adapter, source order dispatcher or SDK writer
 * is synthesized by this origin-specific component. */
export function originCouponPublishingRuntime(
  env: NodeJS.ProcessEnv,
  input: {
    db: Pick<Databases, 'get'>;
    journalKey: string;
    sourceKey: string;
    publicationKey: string;
    publisher: ReturnType<typeof couponGenerationPublisher>;
    enabled: () => boolean;
    controls?: OriginCouponControlsPort;
    clock?: () => number;
    fetcher?: typeof fetch;
  },
) {
  const selector = env.POS_SCREENING_ORIGIN_COUPON_DEMAND_CONTRACT;
  if (!selector) return undefined;
  if (selector !== originCouponDemandContract)
    throw originError('SCREENING_ORIGIN_COUPON_PUBLISHER_CONFIGURATION');
  originHistoryKeys(input.journalKey, input.sourceKey, input.publicationKey);
  const url = env.POS_SCREENING_ORIGIN_COUPON_CONTROLS_URL,
    key = env.POS_SCREENING_ORIGIN_COUPON_CONTROLS_KEY;
  if (!input.controls && (!url || !key))
    throw originError('SCREENING_ORIGIN_COUPON_PUBLISHER_CONFIGURATION');
  if (key) originHistoryKeys(key, input.journalKey, input.sourceKey, input.publicationKey);
  const demands = originCouponDemandJournal(
      input.db,
      { journalKey: input.journalKey },
      input.clock,
    ),
    controls =
      input.controls ??
      originCouponControlsHttp(
        { url: url!, key: key!, sourceKey: input.sourceKey },
        { fetcher: input.fetcher, clock: input.clock },
      ),
    worker = originCouponGenerationWorker({
      demands,
      controls,
      publisher: input.publisher,
      enabled: input.enabled,
    });
  return { demands, drain: worker.drain };
}
