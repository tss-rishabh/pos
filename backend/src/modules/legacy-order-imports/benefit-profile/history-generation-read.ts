import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { benefitCount, benefitHash } from './contracts.js';
import { couponPublicationFactsSchema } from './history-publication.js';
import { couponHistoryWitnessSchema, type CouponHistoryWitness } from './bridge.js';
import { couponWarehouseControlRowSchema } from './history-warehouse-contracts.js';
import {
  generationCaptureSchema,
  generationPublicationSchema,
  generationProjectionSchema,
  generationHeadHash,
  verifyGenerationCapture,
  verifyGenerationFacts,
  generationError,
  type GenerationScope,
  type GenerationCapture,
  type GenerationFacts,
} from './history-generation-contracts.js';
import { generationSql, type GenerationStatement } from './history-generation-query.js';
import {
  generationSdk,
  type GenerationQueryPort,
  type GenerationClient,
} from './history-generation-sdk.js';
import { requireGenerationOptions, type GenerationOptions } from './history-generation-options.js';
const point = z.number().int().positive().safe();
const base = z
  .object({
    contract: z.string(),
    generationId: benefitHash,
    snapshotId: z.uuid(),
    captureHash: benefitHash,
    headHash: benefitHash,
    materializedAt: point,
    captureDocument: z.string().max(262144),
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
function json(text: string, max: number): unknown {
  if (Buffer.byteLength(text) > max) throw generationError('INCOMPLETE');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw generationError('INCOMPLETE');
  }
}
export interface GenerationDependencies {
  query?: GenerationQueryPort;
  clientFactory?: () => GenerationClient;
  clock?: () => number;
}
export function parseGenerationRows(
  raw: unknown,
  scope: GenerationScope,
  witness: CouponHistoryWitness,
  options: GenerationOptions,
  sourceKey: string,
  mode: 'read' | 'candidate',
  now: number,
): GenerationFacts {
  const outer = z
    .array(z.object({ document: z.string().max(1500000) }).strict())
    .length(1)
    .safeParse(raw);
  if (!outer.success) throw generationError('INCOMPLETE');
  const manifest =
    mode === 'read'
      ? base.extend({ publicationDocument: z.string().max(262144) }).strict()
      : base.extend({ candidateComplete: z.literal(true) }).strict();
  const result = z
    .object({
      manifests: z.array(manifest).length(1),
      actual: diagnostics,
      projections: z
        .object({ orders: generationProjectionSchema, logs: generationProjectionSchema })
        .strict(),
      controls: z.array(couponWarehouseControlRowSchema).max(options.maxControls),
      facts: couponPublicationFactsSchema,
    })
    .strict()
    .safeParse(json(outer.data[0]!.document, 1500000));
  if (!result.success) throw generationError('INCOMPLETE');
  const v = result.data,
    m = v.manifests[0]!,
    a = v.actual;
  if (
    a.orders !== a.uniqueOrders ||
    a.logs !== a.uniqueLogs ||
    a.controls !== a.uniqueControls ||
    a.orders !== v.projections.orders.rows ||
    a.logs !== v.projections.logs.rows ||
    a.controls !== String(v.controls.length) ||
    a.lots !== String(v.facts.lotCounts.length) ||
    BigInt(a.lots) > BigInt(options.maxLots) ||
    [a.invalidOrders, a.invalidLogs, a.invalidControls, a.uncoveredLogs, a.uncoveredOrders].some(
      (c) => c !== '0',
    )
  )
    throw generationError('INCOMPLETE');
  const capture = verifyGenerationCapture(
    generationCaptureSchema.parse(json(m.captureDocument, 262144)),
    sourceKey,
    now,
    options.maxLagMs,
  );
  if (
    JSON.stringify(scope) !== JSON.stringify(capture.scope) ||
    m.generationId !== capture.generationId ||
    m.snapshotId !== capture.snapshotId ||
    m.captureHash !== capture.signature ||
    m.headHash !== capture.headHash ||
    capture.headHash !== generationHeadHash(scope, witness, sourceKey)
  )
    throw generationError('INCOMPLETE');
  const target = v.controls.filter((c) => c.couponId === scope.couponId);
  if (target.length !== 1 || !target[0]!.present || !target[0]!.sameCode)
    throw generationError('INCOMPLETE');
  const publication =
    'publicationDocument' in m
      ? generationPublicationSchema.parse(json(m.publicationDocument, 262144))
      : null;
  if (
    m.contract !==
    (mode === 'read'
      ? 'pos-csv-coupon-generation-publication-v1'
      : 'pos-csv-coupon-generation-candidate-v1')
  )
    throw generationError('INCOMPLETE');
  return verifyGenerationFacts(
    {
      capture,
      controls: v.controls,
      facts: v.facts,
      projections: v.projections,
      materializedAt: m.materializedAt,
      publication,
    },
    sourceKey,
    options.comparisonFingerprint!,
    now,
  );
}
export function generationReadRunner(
  options: GenerationOptions,
  authority: { sourceKey: string },
  dependencies: GenerationDependencies = {},
) {
  const clock = dependencies.clock ?? Date.now,
    query = dependencies.query ?? generationSdk(options, dependencies.clientFactory);
  return {
    clock,
    async read(
      scope: GenerationScope,
      witness: CouponHistoryWitness,
      signal: AbortSignal,
      capture?: GenerationCapture,
      selectedMode?: 'read' | 'candidate',
    ) {
      const mode = selectedMode ?? (capture ? 'candidate' : 'read');
      requireGenerationOptions(options, mode);
      const checked = couponHistoryWitnessSchema.parse(witness),
        headHash = generationHeadHash(scope, checked, authority.sourceKey),
        started = clock();
      if (signal.aborted) throw generationError('UNAVAILABLE', 503);
      const input: GenerationStatement = generationSql(options, scope, headHash, capture, mode),
        controller = new AbortController(),
        combined = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        abort = () => {
          controller.abort();
          reject(generationError('UNAVAILABLE', 503));
        };
        timer = setTimeout(abort, options.timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        const rows = await Promise.race([
          deadline,
          (async () => {
            const bytes = await query.estimate(input, combined);
            if (bytes < 0n || bytes > BigInt(options.maxBytes))
              throw generationError('BUDGET', 503);
            combined.throwIfAborted();
            const rows = await query.execute(input, combined);
            combined.throwIfAborted();
            return rows;
          })(),
        ]);
        const now = clock();
        if (now < started) throw generationError('CLOCK');
        return parseGenerationRows(rows, scope, checked, options, authority.sourceKey, mode, now);
      } catch (error) {
        controller.abort();
        if (error instanceof AppError && error.code.startsWith('ORDER_IMPORT_COUPON_PUBLICATION_'))
          throw error;
        throw generationError('UNAVAILABLE', 503);
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
      }
    },
  };
}
