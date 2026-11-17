import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { importResumptionSchema } from './domain.js';
import { importDigest } from './sealed-groups.js';
import {
  legacyOrderImportResumptions as resumptions,
  legacyOrderImports as jobs,
  legacyOrderImportRows as rows,
  type LegacyImportJob,
} from './schema.js';

type Resumption = typeof resumptions.$inferSelect;
type OwnedImport = (
  tx: AdministrationTransaction,
  actorId: string,
  jobId: string,
) => Promise<{ job: LegacyImportJob }>;

export function importResumptions(
  db: Databases,
  secret: string,
  clock: () => number,
  owned: OwnedImport,
) {
  function digest(value: Omit<Resumption, 'proofHash'>) {
    return importDigest(
      secret,
      'request',
      JSON.stringify([
        'pos-order-import-resumption-v1',
        value.id,
        value.jobId,
        value.actorId,
        value.jobRequestHash,
        value.requestId,
        value.claimToken,
        value.acceptedAt,
      ]),
    );
  }
  function receipt(value: Resumption, job: LegacyImportJob) {
    const expected = Buffer.from(digest(value)),
      actual = Buffer.from(value.proofHash);
    if (
      value.jobId !== job.id ||
      value.actorId !== job.actorId ||
      value.jobRequestHash !== job.requestHash ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new AppError(
        409,
        'ORDER_IMPORT_RESUMPTION_CONFLICT',
        'The saved resume reference requires administrator reconciliation.',
      );
    return importResumptionSchema.parse({
      operationId: value.id,
      jobId: value.jobId,
      acceptedAt: value.acceptedAt,
    });
  }
  async function read(actor: string, jobId: string, operationId: string) {
    const actorId = identifier.parse(actor);
    z.uuid().parse(jobId);
    z.uuid().parse(operationId);
    // An immutable resume receipt is operational control metadata. Old financial
    // facts still use the independently qualified BigQuery history reader.
    return db.get('writer').transaction(async (tx) => {
      const { job } = await owned(tx, actorId, jobId);
      const [value] = await tx
        .select()
        .from(resumptions)
        .where(eq(resumptions.id, operationId))
        .limit(1)
        .for('share');
      if (!value || value.jobId !== jobId || value.actorId !== actorId)
        throw new AppError(
          404,
          'ORDER_IMPORT_RESUMPTION_NOT_FOUND',
          'The original resume request has not been confirmed.',
        );
      return receipt(value, job);
    });
  }
  async function resume(actor: string, jobId: string, operationId: string, requestId: string) {
    const actorId = identifier.parse(actor);
    z.uuid().parse(jobId);
    z.uuid().parse(operationId);
    z.string().min(1).max(128).parse(requestId);
    return retryTransaction(() =>
      db.get('writer').transaction(async (tx) => {
        // Native actor/store/counter authority is locked before the original job.
        const { job } = await owned(tx, actorId, jobId),
          claimToken = randomUUID(),
          value = {
            id: operationId,
            jobId,
            actorId,
            jobRequestHash: job.requestHash,
            requestId,
            claimToken,
            acceptedAt: new Date(clock()).toISOString().slice(0, 23).replace('T', ' '),
          };
        await tx
          .insert(resumptions)
          .values({ ...value, proofHash: digest(value) })
          .onDuplicateKeyUpdate({ set: { id: sql`${resumptions.id}` } });
        const [saved] = await tx
          .select()
          .from(resumptions)
          .where(eq(resumptions.id, operationId))
          .limit(1)
          .for('update');
        if (!saved)
          throw new AppError(
            409,
            'ORDER_IMPORT_RESUMPTION_CONFLICT',
            'Refresh the resume receipt.',
          );
        const result = receipt(saved, job);
        // A replay can only read the original acceptance, including after a
        // later access block. It cannot requeue that later block implicitly.
        if (saved.claimToken !== claimToken) return result;
        if (
          job.state !== 'BLOCKED' ||
          job.errorCode !== 'ORDER_IMPORT_ACCESS_CHANGED' ||
          job.claimToken ||
          job.completedAt
        )
          throw new AppError(
            409,
            'ORDER_IMPORT_RESUME_NOT_AVAILABLE',
            'Only an import blocked by changed access can be resumed.',
          );
        const [uncertain] = await tx
          .select({ sequence: rows.sequence })
          .from(rows)
          .where(and(eq(rows.jobId, jobId), inArray(rows.state, ['STARTING', 'RECONCILING'])))
          .limit(1)
          .for('update');
        if (uncertain)
          throw new AppError(
            409,
            'ORDER_IMPORT_IN_FLIGHT',
            'Reconcile the active financial operation before resuming this import.',
          );
        const [pending] = await tx
          .select({ sequence: rows.sequence })
          .from(rows)
          .where(and(eq(rows.jobId, jobId), eq(rows.state, 'PENDING')))
          .limit(1)
          .for('update');
        if (!pending)
          throw new AppError(
            409,
            'ORDER_IMPORT_RESUME_NOT_AVAILABLE',
            'This import has no unsent orders to resume.',
          );
        await tx
          .update(jobs)
          .set({ state: 'QUEUED', errorCode: null, leaseUntil: null, updatedAt: value.acceptedAt })
          .where(eq(jobs.id, jobId));
        return result;
      }),
    );
  }
  return { resume, readResumption: read };
}
