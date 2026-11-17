import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { originDigest, originError, originHashSchema } from './contracts.js';
import {
  originHistoryDemandContract,
  originHistoryDemandSchema,
  type originHistoryJournal,
  type OriginHistoryJournalRecord,
} from './history-generation-demand.js';
import {
  originHistorySnapshotSchema,
  originHistoryPublicationSchema,
  verifyOriginHistorySnapshot,
  originHistoryKeys,
} from './history-contracts.js';
import type { OriginHistorySourcePort } from './history-generation-source.js';
import { sealOriginHistoryPublication } from './history-publication.js';
import {
  originHistoryWarehouseOptionsSchema,
  originHistoryWritePlanSchema,
  originHistoryWriteReplySchema,
  originHistoryWritePlan,
  restoreOriginHistoryWritePlan,
  type originHistoryCandidate,
  type OriginHistoryWriter,
  type OriginHistoryWritePlan,
  type OriginHistoryWriteReply,
} from './history-generation-warehouse.js';

const stateSchema = z
  .object({
    contract: z.literal('pos-screening-origin-history-publisher-v1'),
    scope: originHistoryDemandSchema,
    generationId: originHashSchema.nullable(),
    snapshot: originHistorySnapshotSchema.nullable(),
    options: originHistoryWarehouseOptionsSchema.nullable(),
    materialize: originHistoryWritePlanSchema.nullable(),
    publication: originHistoryPublicationSchema.nullable(),
    publish: originHistoryWritePlanSchema.nullable(),
    materializeReply: originHistoryWriteReplySchema.nullable(),
    publishReply: originHistoryWriteReplySchema.nullable(),
    failure: z
      .string()
      .regex(/^[A-Z_]{1,96}$/)
      .nullable(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Journal = ReturnType<typeof originHistoryJournal>;
function state(record: OriginHistoryJournalRecord, key: string): State {
  const demand = z
    .object({ contract: z.literal(originHistoryDemandContract), scope: originHistoryDemandSchema })
    .strict()
    .safeParse(record.data);
  const result = demand.success
    ? stateSchema.parse({
        contract: 'pos-screening-origin-history-publisher-v1',
        scope: demand.data.scope,
        generationId: null,
        snapshot: null,
        options: null,
        materialize: null,
        publication: null,
        publish: null,
        materializeReply: null,
        publishReply: null,
        failure: null,
      })
    : stateSchema.parse(record.data);
  if (
    record.id !==
    originDigest(key, 'history-demand', {
      customerId: result.scope.customerId,
      witness: result.scope.witness,
    })
  )
    throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_INVALID');
  return result;
}
/** Durable separate publisher. Only source READONLY capture is lease-retryable.
 * After each write checkpoint, every continuation is GET(original job) only. */
export function originHistoryGenerationPublisher(input: {
  journal: Journal;
  journalKey: string;
  captureKey?: string;
  publicationKey?: string;
  options?: unknown;
  source?: OriginHistorySourcePort;
  candidate?: ReturnType<typeof originHistoryCandidate>;
  writer?: OriginHistoryWriter;
  newWorkEnabled: () => boolean;
  clock?: () => number;
}) {
  const options =
      input.options === undefined
        ? undefined
        : originHistoryWarehouseOptionsSchema.parse(input.options),
    clock = input.clock ?? Date.now,
    enabled = () =>
      input.newWorkEnabled() &&
      Boolean(
        options &&
        input.writer &&
        input.source &&
        input.candidate &&
        input.captureKey &&
        input.publicationKey,
      );
  originHistoryKeys(
    input.journalKey,
    ...[input.captureKey, input.publicationKey].filter((value): value is string => Boolean(value)),
  );
  async function acknowledge(
    id: string,
    kind: 'materialize' | 'publish',
    reply: OriginHistoryWriteReply,
  ) {
    return input.journal.change(id, (record) => {
      const data = state(record, input.journalKey),
        plan = kind === 'materialize' ? data.materialize : data.publish;
      if (!plan || plan.jobId !== reply.jobId || plan.hash !== reply.queryHash)
        throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_INVALID');
      const prior = kind === 'materialize' ? data.materializeReply : data.publishReply;
      if (prior?.status === 'succeeded' || prior?.status === 'failed') return null;
      if (record.phase !== (kind === 'materialize' ? 'materializing' : 'publishing')) return null;
      const phase =
        reply.status === 'failed'
          ? 'failed'
          : reply.status === 'succeeded'
            ? kind === 'materialize'
              ? 'materialized'
              : 'published'
            : record.phase;
      return {
        ...record,
        phase,
        data: {
          ...data,
          [kind === 'materialize' ? 'materializeReply' : 'publishReply']: reply,
          failure: phase === 'failed' ? 'SCREENING_ORIGIN_HISTORY_WRITE_FAILED' : data.failure,
        },
      };
    });
  }
  async function remote(
    record: OriginHistoryJournalRecord,
    kind: 'materialize' | 'publish',
    signal: AbortSignal,
    preflighted?: OriginHistoryWritePlan,
  ) {
    const data = state(record, input.journalKey),
      saved = kind === 'materialize' ? data.materialize : data.publish;
    if (!saved || !input.writer) return record;
    const retained = restoreOriginHistoryWritePlan(saved, input.journalKey);
    if (
      preflighted &&
      (preflighted.hash !== retained.hash || preflighted.authHash !== retained.authHash)
    )
      throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_INVALID');
    let result: OriginHistoryWriteReply;
    try {
      result = preflighted
        ? await input.writer.start(preflighted, signal)
        : await input.writer.read(retained, signal);
    } catch {
      return record;
    }
    // A late authentic provider reply remains factual even if new-work config
    // was disabled while awaiting it. This never starts another stage.
    return acknowledge(record.id, kind, originHistoryWriteReplySchema.parse(result));
  }
  const service = {
    read: input.journal.read,
    async advance(id: string, signal: AbortSignal): Promise<OriginHistoryJournalRecord> {
      let record = await input.journal.read(id);
      const data = state(record, input.journalKey);
      if (['published', 'failed', 'superseded'].includes(record.phase)) return record;
      if (['demand', 'capturing'].includes(record.phase)) {
        if (!enabled() || signal.aborted) return record;
        const lease = randomUUID();
        let claimed = false;
        record = await input.journal.change(id, (prior) => {
          if (
            !['demand', 'capturing'].includes(prior.phase) ||
            (prior.leaseUntil !== null && prior.leaseUntil > clock())
          )
            return null;
          claimed = true;
          return {
            ...prior,
            phase: 'capturing',
            data: state(prior, input.journalKey),
            leaseToken: lease,
            leaseUntil: clock() + 30000,
          };
        });
        if (!claimed) return record;
        try {
          const snapshot = verifyOriginHistorySnapshot(
            await input.source!.capture(
              { customerId: data.scope.customerId, witness: data.scope.witness },
              signal,
            ),
            input.captureKey!,
          );
          signal.throwIfAborted();
          const generationId = originDigest(input.journalKey, 'history-generation', {
              demandId: id,
              layout: options,
            }),
            plan = originHistoryWritePlan(snapshot, options!, input.journalKey, generationId);
          return input.journal.change(id, (prior) => {
            if (prior.phase !== 'capturing' || prior.leaseToken !== lease) return null;
            return {
              ...prior,
              phase: 'prepared',
              leaseToken: null,
              leaseUntil: null,
              data: {
                ...state(prior, input.journalKey),
                generationId,
                snapshot,
                options,
                materialize: plan,
              },
            };
          });
        } catch (error) {
          if (
            error instanceof AppError &&
            error.code === 'SCREENING_ORIGIN_HISTORY_GENERATION_SUPERSEDED'
          )
            return input.journal.change(id, (prior) =>
              prior.phase === 'capturing' && prior.leaseToken === lease
                ? { ...prior, phase: 'superseded', leaseToken: null, leaseUntil: null }
                : null,
            );
          // Source capture is readonly. Lease expiry can repeat only this capture,
          // never a warehouse/financial dispatch or an order/provider operation.
          return record;
        }
      }
      if (record.phase === 'materializing') return remote(record, 'materialize', signal);
      if (record.phase === 'publishing') return remote(record, 'publish', signal);
      if (!enabled() || signal.aborted) return record;
      if (record.phase === 'prepared' || record.phase === 'qualified') {
        const kind = record.phase === 'prepared' ? 'materialize' : 'publish',
          savedPlan = kind === 'materialize' ? data.materialize : data.publish,
          version = record.version;
        if (!savedPlan || !data.snapshot || !data.options)
          throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_INVALID');
        verifyOriginHistorySnapshot(data.snapshot, input.captureKey!);
        const plan = restoreOriginHistoryWritePlan(savedPlan, input.journalKey);
        // This readonly provider call must finish before any permanent dispatch
        // checkpoint. A failed estimate leaves the original ready phase intact.
        await input.writer!.preflight(plan, signal);
        if (signal.aborted || !enabled()) return record;
        let send = false;
        record = await input.journal.change(id, (prior) => {
          if (
            prior.version !== version ||
            prior.phase !== (kind === 'materialize' ? 'prepared' : 'qualified')
          )
            return null;
          const saved = state(prior, input.journalKey),
            current = kind === 'materialize' ? saved.materialize : saved.publish;
          if (!current || current.hash !== plan.hash || current.authHash !== plan.authHash)
            throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_INVALID');
          send = true;
          return { ...prior, phase: kind === 'materialize' ? 'materializing' : 'publishing' };
        });
        // The checkpoint remains permanent if cancellation arrives here. Missing
        // job metadata later is UNKNOWN, never permission to re-POST this job.
        if (!send || signal.aborted || !enabled()) return record;
        return remote(record, kind, signal, plan);
      }
      if (record.phase === 'materialized') {
        if (!data.snapshot || !data.options || !data.generationId)
          throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_INVALID');
        const candidate = await input.candidate!.read(data.snapshot, data.generationId, signal),
          sealed = sealOriginHistoryPublication(
            data.snapshot.capture,
            candidate,
            { captureKey: input.captureKey!, publicationKey: input.publicationKey! },
            clock(),
          ),
          plan = originHistoryWritePlan(
            data.snapshot,
            data.options,
            input.journalKey,
            data.generationId,
            sealed.publication,
          );
        return input.journal.change(id, (prior) => {
          if (prior.phase !== 'materialized') return null;
          return {
            ...prior,
            phase: 'qualified',
            data: {
              ...state(prior, input.journalKey),
              publication: sealed.publication,
              publish: plan,
            },
          };
        });
      }
      return record;
    },
    async drain(signal: AbortSignal, limit = 10) {
      const ids = await input.journal.pending(limit),
        summary = { read: 0, advanced: 0, unavailable: 0 };
      for (const id of ids) {
        if (signal.aborted) break;
        try {
          const before = await input.journal.read(id),
            after = await service.advance(id, signal);
          summary.read++;
          if (after.phase !== before.phase) summary.advanced++;
        } catch {
          summary.unavailable++;
        }
      }
      return summary;
    },
  };
  return service;
}
