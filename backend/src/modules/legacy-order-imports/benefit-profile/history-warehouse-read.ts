import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { benefitCount, benefitHash } from './contracts.js';
import { couponHistoryScopeSchema, type CouponHistoryScope } from './history.js';
import { couponHistoryControlHeadHash, type CouponHistoryWitness } from './bridge.js';
import {
  couponPublicationError,
  couponPublicationFactsSchema,
  couponFactsHash,
  couponHistoryPublicationSchema,
  verifyCouponSourceCapture,
  couponSourceInstant,
  type CouponSourceCapture,
  type CouponPublicationFacts,
} from './history-publication.js';
import {
  couponWarehouseDocumentBytes,
  couponWarehouseSourceDocumentBytes,
  couponWarehouseControlsSchema,
  couponWarehouseControlRowSchema,
  verifyCouponWarehouseControls,
  requireCouponWitness,
  type CouponBigQueryOptions,
} from './history-warehouse-contracts.js';
import {
  couponHistorySdk,
  type CouponHistoryQueryPort,
  type CouponHistoryClient,
} from './history-bigquery-sdk.js';
import { couponWarehouseSql, type CouponWarehouseStatement } from './history-warehouse-query.js';
const point = z.number().int().positive().safe();
const manifestBase = z
  .object({
    contract: z.string(),
    generationId: benefitHash,
    snapshotId: z.uuid(),
    sourceCaptureHash: benefitHash,
    controlHeadHash: benefitHash,
    sourceCdcThrough: point,
    sourceCaptureDocument: z.string().max(couponWarehouseSourceDocumentBytes),
    controlDocument: z.string().max(couponWarehouseSourceDocumentBytes),
  })
  .strict();
const diagnostics = z
  .object({
    orders: benefitCount,
    uniqueOrders: benefitCount,
    logs: benefitCount,
    uniqueLogs: benefitCount,
    controls: benefitCount,
    uniqueControls: benefitCount,
    invalidOrders: benefitCount,
    invalidLogs: benefitCount,
    invalidControls: benefitCount,
    uncoveredLogs: benefitCount,
    uncoveredOrders: benefitCount,
    lots: benefitCount,
  })
  .strict();
function decodeJson(value: string, max = couponWarehouseSourceDocumentBytes): unknown {
  if (Buffer.byteLength(value) > max) throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  }
}
export interface CouponWarehouseReadResult {
  capture: CouponSourceCapture;
  facts: CouponPublicationFacts;
  generationId: string;
  snapshotId: string;
  sourceCaptureHash: string;
  controlHeadHash: string;
  sourceCdcThrough: number;
  publication: ReturnType<typeof couponHistoryPublicationSchema.parse> | null;
}
export function parseCouponWarehouseRows(
  raw: unknown,
  scope: CouponHistoryScope,
  witness: CouponHistoryWitness,
  options: CouponBigQueryOptions,
  sourceKey: string,
  mode: 'read' | 'candidate',
  now: number,
): CouponWarehouseReadResult {
  const bounded = z
    .array(z.object({ document: z.string().max(couponWarehouseDocumentBytes) }).strict())
    .length(1)
    .safeParse(raw);
  if (!bounded.success) throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  const decoded = decodeJson(bounded.data[0]!.document, couponWarehouseDocumentBytes),
    manifest =
      mode === 'read'
        ? manifestBase
            .extend({ publicationDocument: z.string().max(couponWarehouseSourceDocumentBytes) })
            .strict()
        : manifestBase.extend({ candidateComplete: z.literal(true) }).strict();
  const parsed = z
    .object({
      manifests: z.array(manifest).length(1),
      actual: diagnostics,
      controls: z.array(couponWarehouseControlRowSchema).max(options.CSV_COUPON_MAX_CONTROLS),
      facts: couponPublicationFactsSchema,
    })
    .strict()
    .safeParse(decoded);
  if (!parsed.success) throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  const value = parsed.data,
    row = value.manifests[0]!,
    a = value.actual;
  if (
    a.orders !== a.uniqueOrders ||
    a.logs !== a.uniqueLogs ||
    a.controls !== a.uniqueControls ||
    a.controls !== String(value.controls.length) ||
    a.lots !== String(value.facts.lotCounts.length) ||
    BigInt(a.lots) > BigInt(options.CSV_COUPON_MAX_LOTS) ||
    [a.invalidOrders, a.invalidLogs, a.invalidControls, a.uncoveredLogs, a.uncoveredOrders].some(
      (count) => count !== '0',
    )
  )
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  const capture = verifyCouponSourceCapture(decodeJson(row.sourceCaptureDocument), sourceKey, now),
    expected = couponHistoryControlHeadHash(scope, witness, sourceKey);
  if (
    JSON.stringify(capture.scope) !== JSON.stringify(couponHistoryScopeSchema.parse(scope)) ||
    row.generationId !== capture.generationId ||
    row.snapshotId !== capture.snapshotId ||
    row.sourceCaptureHash !== capture.signature ||
    row.controlHeadHash !== expected ||
    capture.controlHeadHash !== expected ||
    row.sourceCdcThrough < capture.finishedAt ||
    row.sourceCdcThrough > now
  )
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  const controls = couponWarehouseControlsSchema.parse(decodeJson(row.controlDocument));
  verifyCouponWarehouseControls(
    controls,
    capture,
    value.controls,
    sourceKey,
    options.CSV_COUPON_COMPARISON_FINGERPRINT!,
    now,
  );
  const target = value.controls.filter((control) => control.couponId === scope.couponId);
  if (target.length !== 1 || !target[0]!.present || !target[0]!.sameCode)
    throw couponPublicationError('CONTROLS_INVALID');
  const maximum = BigInt(a.orders) * BigInt(a.logs);
  if (
    [value.facts.globalUsage, value.facts.birthdayTodayUsage, value.facts.customerOrderCount].some(
      (count) => BigInt(count) > BigInt(a.orders),
    ) ||
    BigInt(value.facts.monthlyJoinedUsage) > maximum ||
    value.facts.lotCounts.reduce((sum, row) => sum + BigInt(row.usedCount), 0n) > maximum
  )
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  // Recheck the native signed facts even when a publication key is configured;
  // a hand-authored publication cannot substitute copied or changed counts.
  if (couponFactsHash(scope, value.facts, sourceKey) !== capture.factsHash)
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  const publication =
    'publicationDocument' in row
      ? couponHistoryPublicationSchema.parse(decodeJson(row.publicationDocument))
      : null;
  if (
    publication &&
    (row.contract !== publication.contract ||
      publication.generationId !== row.generationId ||
      publication.snapshotId !== row.snapshotId ||
      publication.sourceCaptureHash !== row.sourceCaptureHash ||
      publication.controlHeadHash !== expected ||
      publication.sourceCdcThrough !== row.sourceCdcThrough)
  )
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  if (!publication && row.contract !== 'pos-csv-coupon-warehouse-candidate-v1')
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  return {
    capture,
    facts: value.facts,
    generationId: row.generationId,
    snapshotId: row.snapshotId,
    sourceCaptureHash: row.sourceCaptureHash,
    controlHeadHash: row.controlHeadHash,
    sourceCdcThrough: row.sourceCdcThrough,
    publication,
  };
}
export interface CouponWarehouseDependencies {
  query?: CouponHistoryQueryPort;
  clientFactory?: () => CouponHistoryClient;
  clock?: () => number;
}
/** Shared bounded read runner for candidate verification and published runtime
 * eligibility. This runner has no native DB handle or history fallback. */
export function couponWarehouseReadRunner(
  options: CouponBigQueryOptions,
  dependencies: CouponWarehouseDependencies = {},
) {
  const clock = dependencies.clock ?? Date.now,
    query = dependencies.query ?? couponHistorySdk(options, dependencies.clientFactory);
  return {
    clock,
    async read(
      scope: CouponHistoryScope,
      witness: CouponHistoryWitness,
      sourceKey: string,
      signal: AbortSignal,
      mode: 'read' | 'candidate',
      capture?: CouponSourceCapture,
    ) {
      const expected = requireCouponWitness(scope, witness, sourceKey),
        started = clock(),
        at = couponSourceInstant(scope);
      if (
        scope.sourceTimeZone !== options.CSV_COUPON_SOURCE_TIMEZONE ||
        at > started ||
        started - at > options.CSV_COUPON_MAX_LAG_SECONDS * 1000 ||
        signal.aborted
      )
        throw couponPublicationError('WAREHOUSE_STALE');
      const input: CouponWarehouseStatement = couponWarehouseSql(
          options,
          scope,
          couponHistoryControlHeadHash(scope, expected, sourceKey),
          capture,
        ),
        controller = new AbortController(),
        combined = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        abort = () => {
          controller.abort();
          reject(couponPublicationError('WAREHOUSE_UNAVAILABLE', 503));
        };
        timer = setTimeout(abort, options.CSV_COUPON_QUERY_TIMEOUT_MS);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        const raw = await Promise.race([
          deadline,
          (async () => {
            const estimate = await query.estimate(input, combined);
            if (estimate < 0n || estimate > BigInt(options.CSV_COUPON_MAX_BYTES_BILLED))
              throw couponPublicationError('WAREHOUSE_BUDGET', 503);
            combined.throwIfAborted();
            const rows = await query.execute(input, combined);
            combined.throwIfAborted();
            return rows;
          })(),
        ]);
        const finished = clock();
        if (finished < started || finished - at > options.CSV_COUPON_MAX_LAG_SECONDS * 1000)
          throw couponPublicationError('WAREHOUSE_STALE');
        return parseCouponWarehouseRows(raw, scope, expected, options, sourceKey, mode, finished);
      } catch (error) {
        controller.abort();
        if (error instanceof AppError && error.code.startsWith('ORDER_IMPORT_COUPON_PUBLICATION_'))
          throw error;
        throw couponPublicationError('WAREHOUSE_UNAVAILABLE', 503);
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
      }
    },
  };
}
