import {
  verifyCouponSourceCapture,
  sealCouponHistoryPublication,
  couponPublicationError,
  type CouponSourceCapture,
} from './history-publication.js';
import {
  couponBigQueryOptionsSchema,
  couponWarehouseKeys,
  requireCouponWarehouseOptions,
  type CouponBigQueryOptions,
} from './history-warehouse-contracts.js';
import {
  couponWarehouseReadRunner,
  type CouponWarehouseDependencies,
  type CouponWarehouseReadResult,
} from './history-warehouse-read.js';
import { couponHistoryWitnessSchema } from './bridge.js';
export interface CouponWarehouseCapturePort {
  read(
    capture: CouponSourceCapture,
    options?: { signal?: AbortSignal },
  ): Promise<CouponWarehouseReadResult>;
}
/** Independent candidate SELECT before any COMPLETE publication. No source
 * facts are copied into a warehouse success declaration and no cloud write is
 * performed. A trusted operator may review/publish the returned signed artifact. */
export function couponWarehouseCapture(
  supplied: CouponBigQueryOptions,
  authority: { sourceKey: string },
  dependencies: CouponWarehouseDependencies = {},
): CouponWarehouseCapturePort {
  const parsed = couponBigQueryOptionsSchema.safeParse(supplied);
  if (!parsed.success) throw couponPublicationError('CONFIGURATION', 503);
  couponWarehouseKeys(authority.sourceKey);
  const options = Object.freeze(parsed.data),
    sourceKey = authority.sourceKey,
    runner = couponWarehouseReadRunner(options, dependencies);
  return {
    async read(value, readOptions) {
      requireCouponWarehouseOptions(options, 'candidate');
      const capture = verifyCouponSourceCapture(value, sourceKey, runner.clock());
      const witness = couponHistoryWitnessSchema.parse({
        writersContract: capture.writersContract,
        writersDefinitionHash: capture.writersDefinitionHash,
        serverUuid: capture.serverUuid,
        sourceSchema: capture.sourceSchema,
        heads: capture.heads,
      });
      const result = await runner.read(
        capture.scope,
        witness,
        sourceKey,
        readOptions?.signal ?? new AbortController().signal,
        'candidate',
        capture,
      );
      if (result.sourceCaptureHash !== capture.signature)
        throw couponPublicationError('WAREHOUSE_INCOMPLETE');
      return result;
    },
  };
}
export async function sealCouponWarehousePublication(
  capture: CouponSourceCapture,
  warehouse: CouponWarehouseCapturePort,
  authority: { sourceKey: string; publicationKey: string; historyKey: string },
  options: { signal?: AbortSignal; clock?: () => number } = {},
) {
  couponWarehouseKeys(authority.sourceKey, authority.publicationKey, authority.historyKey);
  const clock = options.clock ?? Date.now;
  const source = verifyCouponSourceCapture(capture, authority.sourceKey, clock()),
    facts = await warehouse.read(source, { signal: options.signal });
  options.signal?.throwIfAborted();
  verifyCouponSourceCapture(source, authority.sourceKey, clock());
  return sealCouponHistoryPublication(source, facts, authority, clock());
}
