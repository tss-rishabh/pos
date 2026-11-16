import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, count, eq, inArray, lt, ne, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { scheduleInput, type ScheduleInput, type ScheduledArtifact } from './scheduled-domain.js';
import { scheduledReportBuilder } from './scheduled-data.js';
import type { ScheduledReportOptions } from './scheduled-options.js';
import {
  scheduledReportChannels,
  scheduledReportJobs,
  scheduledReportTargets,
  type ScheduledReportJob,
  type ScheduledReportTarget,
  type ScheduledJobStatus,
} from './scheduled-schema.js';
export type ScheduledBuilder = (
  input: ScheduleInput & { date: string },
) => Promise<ScheduledArtifact>;
export type ScheduledSender = (
  target: 'main' | 'demo',
  text: string,
  deliveryId: string,
) => Promise<void>;
export function scheduledReportSender(
  config: Config,
  options: ScheduledReportOptions,
): ScheduledSender {
  return async (target, text, deliveryId) => {
    const value = target === 'main' ? options.SLACK_URL : options.SLACK_DEMO_URL;
    if (config.DEMO_MODE || !value)
      throw new AppError(
        503,
        'REPORT_DELIVERY_UNAVAILABLE',
        'The report delivery channel is unavailable.',
      );
    try {
      const response = await fetch(value, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': deliveryId },
        body: JSON.stringify({
          text,
          parse: 'none',
          link_names: false,
          unfurl_links: false,
          unfurl_media: false,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Unconfirmed delivery');
    } catch {
      throw new AppError(
        502,
        'REPORT_DELIVERY_UNKNOWN',
        'The external report delivery requires reconciliation.',
      );
    }
  };
}
const instant = (value: Temporal.Instant) =>
  value
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ smallestUnit: 'millisecond' })
    .replace('T', ' ');
const artifactSchema = z.object({
  recordCount: z.number().int().min(0).max(70000),
  messages: z.array(z.object({ target: z.enum(['main', 'demo']), text: z.string() })).max(2),
});
/** Preserve the complete text while staying below Slack's per-message truncation boundary. */
export function scheduledMessageParts(value: ScheduledArtifact) {
  const artifact = artifactSchema.parse(value),
    parts: { target: 'main' | 'demo'; part: number; text: string }[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  for (const message of artifact.messages) {
    bytes += Buffer.byteLength(message.text);
    if (bytes > 8 * 1024 * 1024 || seen.has(message.target))
      throw new AppError(
        422,
        'REPORT_TOO_LARGE',
        'The scheduled report exceeds the delivery limit.',
      );
    seen.add(message.target);
    const chars = Array.from(message.text);
    for (let offset = 0, part = 0; offset < chars.length; offset += 35000, part++)
      parts.push({
        target: message.target,
        part,
        text: chars.slice(offset, offset + 35000).join(''),
      });
  }
  return { recordCount: artifact.recordCount, parts };
}
function receipt(job: ScheduledReportJob, targets: readonly ScheduledReportTarget[] = []) {
  return {
    id: job.id,
    kind: job.input.kind,
    date: job.input.date,
    status: job.status,
    recordCount: job.recordCount,
    requestedAt: job.requestedAt.replace(' ', 'T') + 'Z',
    completedAt: job.completedAt ? job.completedAt.replace(' ', 'T') + 'Z' : null,
    errorCode: job.errorCode,
    targets: targets.map((target) => ({
      id: target.id,
      target: target.target,
      part: target.part,
      status: target.status,
    })),
  };
}
export interface ScheduledWorkerResult {
  jobId: string;
  kind: ScheduleInput['kind'];
  status: ScheduledJobStatus;
  requestId: string | null;
  userId: string;
  errorCode: string | null;
}
const workerResult = (job: ScheduledReportJob): ScheduledWorkerResult => ({
  jobId: job.id,
  kind: job.input.kind,
  status: job.status,
  requestId: job.requestId,
  userId: job.userId,
  errorCode: job.errorCode,
});
export function scheduledReportService(
  config: Config,
  db: Databases,
  options: ScheduledReportOptions,
  builder: ScheduledBuilder = scheduledReportBuilder(config, db, options),
  sender: ScheduledSender = scheduledReportSender(config, options),
  clock = () => Temporal.Now.instant(),
) {
  const transaction = <T>(operation: (tx: AdministrationTransaction) => Promise<T>) =>
    retryTransaction(() => db.get('writer').transaction(operation));
  async function jobFor(tx: AdministrationTransaction, id: string) {
    const [job] = await tx
      .select()
      .from(scheduledReportJobs)
      .where(eq(scheduledReportJobs.id, id))
      .limit(1)
      .for('update');
    if (!job) throw new AppError(404, 'SCHEDULED_REPORT_NOT_FOUND', 'Scheduled report not found.');
    return job;
  }
  async function refresh(tx: AdministrationTransaction, jobId: string) {
    await jobFor(tx, jobId);
    const targets = await tx
        .select()
        .from(scheduledReportTargets)
        .where(eq(scheduledReportTargets.jobId, jobId))
        .for('update'),
      status: ScheduledJobStatus = targets.every((target) => target.status === 'DELIVERED')
        ? 'DELIVERED'
        : targets.some((target) => target.status === 'UNKNOWN')
          ? 'DELIVERY_UNKNOWN'
          : 'READY';
    await tx
      .update(scheduledReportJobs)
      .set({
        status,
        errorCode: status === 'DELIVERY_UNKNOWN' ? 'REPORT_DELIVERY_UNKNOWN' : null,
        updatedAt: instant(clock()),
        completedAt: status === 'DELIVERED' ? instant(clock()) : null,
      })
      .where(eq(scheduledReportJobs.id, jobId));
    return jobFor(tx, jobId);
  }
  async function expireDelivery() {
    return transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(scheduledReportTargets)
        .where(
          and(
            eq(scheduledReportTargets.status, 'SENDING'),
            lt(scheduledReportTargets.leaseUntil, instant(clock())),
          ),
        )
        .orderBy(asc(scheduledReportTargets.leaseUntil))
        .limit(1);
      if (!target) return null;
      await jobFor(tx, target.jobId);
      const [current] = await tx
        .select()
        .from(scheduledReportTargets)
        .where(
          and(
            eq(scheduledReportTargets.id, target.id),
            eq(scheduledReportTargets.status, 'SENDING'),
            lt(scheduledReportTargets.leaseUntil, instant(clock())),
          ),
        )
        .for('update');
      if (!current) return null;
      await tx
        .update(scheduledReportTargets)
        .set({ status: 'UNKNOWN', claimToken: null, leaseUntil: null, updatedAt: instant(clock()) })
        .where(eq(scheduledReportTargets.id, target.id));
      return workerResult(await refresh(tx, target.jobId));
    });
  }
  async function claimTarget() {
    return transaction(async (tx) => {
      const previous = alias(scheduledReportTargets, 'scheduled_previous');
      for (const targetName of ['main', 'demo'] as const) {
        const endpoint = targetName === 'main' ? options.SLACK_URL : options.SLACK_DEMO_URL,
          channelId = createHash('sha256')
            .update(endpoint || 'unconfigured-' + targetName)
            .digest('hex'),
          now = instant(clock());
        await tx
          .insert(scheduledReportChannels)
          .values({ id: channelId, nextAllowedAt: now })
          .onDuplicateKeyUpdate({ set: { id: channelId } });
        const [channel] = await tx
          .select()
          .from(scheduledReportChannels)
          .where(eq(scheduledReportChannels.id, channelId))
          .for('update', { skipLocked: true });
        if (!channel || channel.nextAllowedAt > now) continue;
        const [row] = await tx
          .select({ target: scheduledReportTargets, job: scheduledReportJobs })
          .from(scheduledReportTargets)
          .innerJoin(scheduledReportJobs, eq(scheduledReportJobs.id, scheduledReportTargets.jobId))
          .where(
            and(
              eq(scheduledReportTargets.target, targetName),
              eq(scheduledReportTargets.status, 'PENDING'),
              inArray(scheduledReportJobs.status, ['READY', 'DELIVERY_UNKNOWN']),
              notExists(
                tx
                  .select({ id: previous.id })
                  .from(previous)
                  .where(
                    and(
                      eq(previous.jobId, scheduledReportTargets.jobId),
                      eq(previous.target, scheduledReportTargets.target),
                      lt(previous.part, scheduledReportTargets.part),
                      ne(previous.status, 'DELIVERED'),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(scheduledReportJobs.requestedAt), asc(scheduledReportTargets.part))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) continue;
        const token = randomUUID();
        await tx
          .update(scheduledReportTargets)
          .set({
            status: 'SENDING',
            claimToken: token,
            leaseUntil: instant(clock().add({ seconds: 15 })),
            attemptedAt: now,
            updatedAt: now,
          })
          .where(eq(scheduledReportTargets.id, row.target.id));
        await tx
          .update(scheduledReportChannels)
          .set({ nextAllowedAt: instant(clock().add({ seconds: 1 })) })
          .where(eq(scheduledReportChannels.id, channelId));
        return { ...row, token };
      }
      return null;
    });
  }
  async function deliverOne() {
    const claimed = await claimTarget();
    if (!claimed) return null;
    let delivered = false;
    try {
      await sender(claimed.target.target, claimed.target.body, claimed.target.id);
      delivered = true;
    } catch {}
    return transaction(async (tx) => {
      await jobFor(tx, claimed.job.id);
      await tx
        .update(scheduledReportTargets)
        .set({
          status: delivered ? 'DELIVERED' : 'UNKNOWN',
          claimToken: null,
          leaseUntil: null,
          deliveredAt: delivered ? instant(clock()) : null,
          updatedAt: instant(clock()),
        })
        .where(
          and(
            eq(scheduledReportTargets.id, claimed.target.id),
            eq(scheduledReportTargets.claimToken, claimed.token),
            eq(scheduledReportTargets.status, 'SENDING'),
          ),
        );
      return workerResult(await refresh(tx, claimed.job.id));
    });
  }
  async function buildOne() {
    const claimed = await transaction(async (tx) => {
      const [stale] = await tx
        .select()
        .from(scheduledReportJobs)
        .where(
          and(
            eq(scheduledReportJobs.status, 'BUILDING'),
            lt(scheduledReportJobs.leaseUntil, instant(clock())),
          ),
        )
        .orderBy(asc(scheduledReportJobs.leaseUntil))
        .limit(1)
        .for('update', { skipLocked: true });
      if (stale) {
        await tx
          .update(scheduledReportJobs)
          .set({
            status: 'FAILED',
            errorCode: 'SCHEDULED_REPORT_BUILD_INTERRUPTED',
            claimToken: null,
            leaseUntil: null,
            updatedAt: instant(clock()),
          })
          .where(eq(scheduledReportJobs.id, stale.id));
        return {
          ...stale,
          status: 'FAILED' as const,
          errorCode: 'SCHEDULED_REPORT_BUILD_INTERRUPTED',
          claimToken: '',
          interrupted: true,
        };
      }
      const [job] = await tx
        .select()
        .from(scheduledReportJobs)
        .where(eq(scheduledReportJobs.status, 'QUEUED'))
        .orderBy(asc(scheduledReportJobs.requestedAt), asc(scheduledReportJobs.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return null;
      const token = randomUUID();
      await tx
        .update(scheduledReportJobs)
        .set({
          status: 'BUILDING',
          claimToken: token,
          leaseUntil: instant(clock().add({ seconds: 120 })),
          updatedAt: instant(clock()),
        })
        .where(eq(scheduledReportJobs.id, job.id));
      return { ...job, claimToken: token, interrupted: false };
    });
    if (!claimed) return null;
    if (claimed.interrupted) return workerResult(claimed);
    try {
      const artifact = scheduledMessageParts(await builder(claimed.input));
      return transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(scheduledReportJobs)
          .where(
            and(
              eq(scheduledReportJobs.id, claimed.id),
              eq(scheduledReportJobs.claimToken, claimed.claimToken),
              eq(scheduledReportJobs.status, 'BUILDING'),
            ),
          )
          .for('update');
        if (!job) return workerResult(await jobFor(tx, claimed.id));
        const now = instant(clock());
        if (artifact.parts.length)
          await tx.insert(scheduledReportTargets).values(
            artifact.parts.map((part) => ({
              id: randomUUID(),
              jobId: job.id,
              target: part.target,
              part: part.part,
              body: part.text,
              status: 'PENDING' as const,
              updatedAt: now,
            })),
          );
        await tx
          .update(scheduledReportJobs)
          .set({
            status: artifact.parts.length ? 'READY' : 'DELIVERED',
            recordCount: artifact.recordCount,
            claimToken: null,
            leaseUntil: null,
            updatedAt: now,
            completedAt: artifact.parts.length ? null : now,
          })
          .where(eq(scheduledReportJobs.id, job.id));
        return workerResult(await jobFor(tx, job.id));
      });
    } catch (error) {
      const allowed = [
          'DEPENDENCY_UNAVAILABLE',
          'REPORT_TOO_LARGE',
          'REPORT_VIEW_INVALID',
          'REPORT_DATA_INVALID',
          'LEGACY_REPORT_RECONCILIATION_REQUIRED',
          'CRM_LOOKUP_FAILED',
          'CRM_REPORT_TOO_LARGE',
          'CRM_STATUS_UNSUPPORTED',
          'SCHEDULED_REPORT_QUERY_FAILED',
        ],
        code =
          error instanceof AppError && allowed.includes(error.code)
            ? error.code
            : 'SCHEDULED_REPORT_BUILD_FAILED';
      return transaction(async (tx) => {
        await tx
          .update(scheduledReportJobs)
          .set({
            status: 'FAILED',
            errorCode: code,
            claimToken: null,
            leaseUntil: null,
            updatedAt: instant(clock()),
          })
          .where(
            and(
              eq(scheduledReportJobs.id, claimed.id),
              eq(scheduledReportJobs.claimToken, claimed.claimToken),
              eq(scheduledReportJobs.status, 'BUILDING'),
            ),
          );
        return workerResult(await jobFor(tx, claimed.id));
      });
    }
  }
  return {
    async create(commandId: string, value: unknown, requestId: string | null = null) {
      const input = scheduleInput.parse(value),
        requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        today = clock().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate(),
        selected = Temporal.PlainDate.from(
          input.date ||
            (input.kind === 'hyperlocal-store-status'
              ? today.toString()
              : today
                  .subtract({
                    days:
                      input.kind === 'hyperlocal-performance' ? options.DAYS_BEFORE_FOR_MIN_MAX : 1,
                  })
                  .toString()),
        ),
        span = today.since(selected, { largestUnit: 'days' }).days;
      if (span > 62 || (input.kind === 'hyperlocal-store-status' ? span !== 0 : span < 1))
        throw new AppError(
          400,
          'INVALID_DATE_RANGE',
          'Choose a completed report day from the preceding 62 days; store availability uses today.',
        );
      if (
        input.kind !== 'crm-tickets' &&
        (input.previousDays !== 1 || !input.sendToSlack || input.includeCompleted)
      )
        throw new AppError(
          400,
          'INVALID_REPORT_OPTIONS',
          'Ticket refresh options apply only to CRM reports.',
        );
      return transaction(async (tx) => {
        const id = randomUUID(),
          now = instant(clock());
        await tx
          .insert(scheduledReportJobs)
          .values({
            id,
            commandId,
            requestHash,
            requestId,
            userId: 'service-reports',
            input: { ...input, date: selected.toString() },
            status: 'QUEUED',
            requestedAt: now,
            updatedAt: now,
          })
          .onDuplicateKeyUpdate({ set: { commandId } });
        const [job] = await tx
          .select()
          .from(scheduledReportJobs)
          .where(eq(scheduledReportJobs.commandId, commandId))
          .for('update');
        if (!job)
          throw new AppError(
            503,
            'SCHEDULED_REPORT_UNAVAILABLE',
            'The report request could not be recorded.',
          );
        if (job.requestHash !== requestHash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This command identifier was used for another report.',
          );
        if (job.id === id) {
          const [pending] = await tx
            .select({ value: count() })
            .from(scheduledReportJobs)
            .where(
              inArray(scheduledReportJobs.status, [
                'QUEUED',
                'BUILDING',
                'READY',
                'DELIVERY_UNKNOWN',
              ]),
            );
          if ((pending?.value || 0) > options.SCHEDULED_REPORT_MAX_PENDING)
            throw new AppError(
              429,
              'SCHEDULED_REPORT_QUEUE_LIMIT',
              'Finish or reconcile pending reports before requesting more.',
            );
        }
        return receipt(job);
      });
    },
    async read(id: string) {
      return transaction(async (tx) => {
        const job = await jobFor(tx, id),
          targets = await tx
            .select()
            .from(scheduledReportTargets)
            .where(eq(scheduledReportTargets.jobId, id))
            .orderBy(asc(scheduledReportTargets.target), asc(scheduledReportTargets.part));
        return receipt(job, targets);
      });
    },
    async reconcile(
      jobId: string,
      targetId: string,
      commandId: string,
      outcome: 'delivered' | 'not-delivered',
    ) {
      return transaction(async (tx) => {
        await jobFor(tx, jobId);
        const [target] = await tx
          .select()
          .from(scheduledReportTargets)
          .where(
            and(eq(scheduledReportTargets.id, targetId), eq(scheduledReportTargets.jobId, jobId)),
          )
          .for('update');
        if (!target)
          throw new AppError(404, 'REPORT_TARGET_NOT_FOUND', 'Report delivery target not found.');
        if (target.reconciliationCommandId === commandId) {
          if (target.reconciliationOutcome !== outcome)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This reconciliation identifier was used with another outcome.',
            );
          return receipt(await jobFor(tx, jobId));
        }
        if (target.status !== 'UNKNOWN')
          throw new AppError(
            409,
            'REPORT_TARGET_NOT_UNCERTAIN',
            'Only uncertain report deliveries can be reconciled.',
          );
        await tx
          .update(scheduledReportTargets)
          .set({
            status: outcome === 'delivered' ? 'DELIVERED' : 'PENDING',
            deliveredAt: outcome === 'delivered' ? instant(clock()) : null,
            reconciliationCommandId: commandId,
            reconciliationOutcome: outcome,
            updatedAt: instant(clock()),
          })
          .where(eq(scheduledReportTargets.id, targetId));
        return receipt(await refresh(tx, jobId));
      });
    },
    async runOne() {
      return (await expireDelivery()) || (await deliverOne()) || (await buildOne());
    },
  };
}
