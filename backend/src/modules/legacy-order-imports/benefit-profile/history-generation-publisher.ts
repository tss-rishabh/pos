import { createHash } from 'node:crypto';
import { AppError } from '../../../domain/errors.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
import {
  generationScopeSchema,
  generationError,
  sealGenerationPublication,
  type GenerationScope,
} from './history-generation-contracts.js';
import {
  generationOptionsSchema,
  requireGenerationOptions,
  type GenerationOptions,
} from './history-generation-options.js';
import {
  verifyGenerationControl,
  type GenerationControlDescriptor,
  type GenerationControlPort,
  generationPositiveId,
} from './history-generation-control.js';
import {
  generationWritePlan,
  restoreGenerationWritePlan,
  type GenerationWritePlan,
  type GenerationWriteReply,
  type GenerationWritePort,
} from './history-generation-writer.js';
import type { GenerationJournal, GenerationJournalRecord } from './history-generation-journal.js';
import type { GenerationSourcePort } from './history-generation-source.js';
import type { GenerationCandidatePort } from './history-generation-candidate.js';
import type { GenerationAuthority } from './history-generation-runtime.js';
function unknown(plan: GenerationWritePlan): GenerationWriteReply {
  const body = { status: 'unknown' as const, jobId: plan.jobId, queryHash: plan.hash };
  return { ...body, evidenceHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
/** Explicit background publisher; NEVER part of the request/runtime reader.
 * Source capture and all HTTP happen outside journal SQL transactions. */
export function couponGenerationPublisher(
  supplied: GenerationOptions,
  authority: GenerationAuthority,
  dependencies: {
    source: GenerationSourcePort;
    journal: GenerationJournal;
    candidate: GenerationCandidatePort;
    control?: GenerationControlPort;
    writer?: GenerationWritePort;
    newWorkEnabled?: () => boolean;
    clock?: () => number;
  },
) {
  const parsed = generationOptionsSchema.safeParse(supplied);
  if (!parsed.success) throw generationError('CONFIGURATION', 503);
  couponWarehouseKeys(authority.sourceKey, authority.publicationKey, authority.historyKey);
  const options = Object.freeze(parsed.data),
    keys = Object.freeze({ ...authority }),
    clock = dependencies.clock ?? Date.now,
    enabled = () => dependencies.newWorkEnabled?.() === true && Boolean(dependencies.writer);
  const job = (record: GenerationJournalRecord, kind: 'materialize' | 'publish') => {
    const saved = kind === 'materialize' ? record.materialize : record.publish;
    if (!saved) throw generationError('JOURNAL');
    return restoreGenerationWritePlan(saved, keys.sourceKey);
  };
  async function reply(
    record: GenerationJournalRecord,
    kind: 'materialize' | 'publish',
    start: boolean,
    signal: AbortSignal,
  ) {
    if (!dependencies.writer) return record;
    const plan = job(record, kind);
    let result: GenerationWriteReply;
    try {
      result = start
        ? await dependencies.writer.start(plan, signal)
        : await dependencies.writer.read(plan, signal);
    } catch {
      result = unknown(plan);
    }
    // Retain factual original-job evidence even if new work was disabled while
    // awaiting the remote job. This is not permission for another write.
    return dependencies.journal.acknowledge(record.id, kind, result);
  }
  const service = {
    async prepare(input: GenerationScope, descriptor: GenerationControlDescriptor) {
      if (!enabled()) throw generationError('WRITER_REQUIRED', 503);
      requireGenerationOptions(options, 'read');
      requireGenerationOptions(options, 'candidate');
      if (!options.sourceOrdersByCustomer || !options.sourceOrdersByCoupon)
        throw generationError('SOURCE_LAYOUT_REQUIRED', 503);
      const scope = generationScopeSchema.parse(input),
        control = verifyGenerationControl(descriptor, keys.sourceKey, clock()),
        d = control.data;
      if (
        d.couponId !== scope.couponId ||
        d.configurationHash !== scope.configurationHash ||
        d.sourceTimeZone !== scope.sourceTimeZone ||
        d.sourceDay !== scope.sourceDay
      )
        throw generationError('CONTROL_REQUIRED', 503);
      const snapshot = await dependencies.source.capture(scope, control);
      if (!enabled()) throw generationError('WRITER_REQUIRED', 503);
      const plan = generationWritePlan(snapshot, options, keys.sourceKey, undefined, clock());
      return dependencies.journal.create(snapshot, options, plan);
    },
    read: (id: string) => dependencies.journal.read(id),
    async prepareCustomer(customerId: string, signal: AbortSignal) {
      if (!generationPositiveId.safeParse(customerId).success) throw generationError('SCOPE');
      if (!enabled() || !dependencies.control) throw generationError('CONTROL_REQUIRED', 503);
      const control = verifyGenerationControl(
          await dependencies.control.read(signal),
          keys.sourceKey,
          clock(),
        ),
        d = control.data;
      signal.throwIfAborted();
      return service.prepare(
        {
          customerId,
          couponId: d.couponId,
          configurationHash: d.configurationHash,
          sourceTimeZone: d.sourceTimeZone,
          sourceDay: d.sourceDay,
        },
        control,
      );
    },
    async advance(id: string, signal: AbortSignal): Promise<GenerationJournalRecord> {
      let record = await dependencies.journal.read(id);
      if (['published', 'failed'].includes(record.phase)) return record;
      try {
        if (record.phase === 'prepared') {
          if (!enabled() || signal.aborted) return record;
          const claimed = await dependencies.journal.claim(id, 'materialize');
          if (!claimed.send) return claimed.record;
          if (!enabled() || signal.aborted) return claimed.record;
          return reply(claimed.record, 'materialize', true, signal);
        }
        if (record.phase === 'materializing') return reply(record, 'materialize', false, signal);
        if (record.phase === 'materialized') {
          if (!enabled() || signal.aborted) return record;
          const actual = await dependencies.candidate.read(record.snapshot.capture, signal);
          const publication = sealGenerationPublication(
              actual,
              keys,
              record.options.comparisonFingerprint!,
              clock(),
            ),
            plan = generationWritePlan(
              record.snapshot,
              record.options,
              keys.sourceKey,
              publication,
              clock(),
            );
          return dependencies.journal.qualified(id, publication, plan);
        }
        if (record.phase === 'qualified') {
          if (!enabled() || signal.aborted) return record;
          const claimed = await dependencies.journal.claim(id, 'publish');
          if (!claimed.send) return claimed.record;
          if (!enabled() || signal.aborted) return claimed.record;
          return reply(claimed.record, 'publish', true, signal);
        }
        if (record.phase === 'publishing') {
          if (record.publishReply?.status !== 'succeeded')
            record = await reply(record, 'publish', false, signal);
          if (record.publishReply?.status === 'succeeded') {
            // A successful remote job is accepted only after the writer adapter has
            // authenticated its exact original script, typed parameter values, job
            // scope and DONE/no-error result. That script asserts one qualified
            // candidate and atomically INSERTs this exact retained publication.
            return dependencies.journal.completed(
              id,
              record.snapshot.capture.signature,
              record.publication!.seal,
            );
          }
        }
        return record;
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code.startsWith('ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_') &&
          ['prepared', 'materialized'].includes(record.phase)
        )
          return dependencies.journal.refuse(id, error.code);
        throw error;
      }
    },
  };
  return service;
}
