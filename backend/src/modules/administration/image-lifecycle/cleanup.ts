import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { retryTransaction } from '../../../db/retry.js';
import { AppError } from '../../../domain/errors.js';
import type { DocumentationMediaStore } from '../media-storage.js';
import type { ImageOwnerAdapter } from './domain.js';
import type { ImageTables } from './schema.js';

export interface ImageCleanupEvent {
  module: string;
  resource: string;
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  jobId?: string;
  errorCode?: string;
}
export function ownedImageCleanup(
  db: Databases,
  tables: ImageTables,
  owner: Pick<ImageOwnerAdapter, 'referencedKeys' | 'allowsCleanupKey' | 'errorPrefix'>,
  store: DocumentationMediaStore,
  trace: { module: string; resource: string },
  log: (event: ImageCleanupEvent) => void,
  now: () => number = Date.now,
) {
  const { uploads, jobs } = tables,
    abort = new AbortController();
  let active: Promise<number> | undefined,
    stopped = false;
  async function batch() {
    if (stopped) return 0;
    const due = await retryTransaction(() =>
      db.get('writer').transaction(async (tx) => {
        await tx
          .update(jobs)
          .set({ state: 'pending', leaseToken: null, leaseUntil: null })
          .where(and(eq(jobs.state, 'dispatching'), lte(jobs.leaseUntil, new Date(now()))))
          .limit(10);
        const rows = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.state, 'pending'), lte(jobs.availableAt, new Date(now()))))
          .orderBy(asc(jobs.availableAt), asc(jobs.id))
          .limit(5)
          .for('update', { skipLocked: true });
        for (const row of rows) {
          row.attempts++;
          row.leaseToken = crypto.randomUUID();
          await tx
            .update(jobs)
            .set({
              state: 'dispatching',
              attempts: row.attempts,
              leaseToken: row.leaseToken,
              leaseUntil: new Date(now() + 60000),
            })
            .where(eq(jobs.id, row.id));
        }
        return rows;
      }),
    );
    const records = due.length
      ? await db
          .get('writer')
          .select()
          .from(uploads)
          .where(inArray(uploads.id, [...new Set(due.map((job) => job.uploadId))]))
      : [];
    const uploadsById = new Map(records.map((upload) => [upload.id, upload]));
    const keys = records.map((upload) => upload.objectKey);
    const referenced = keys.length
      ? await db.get('writer').transaction((tx) => owner.referencedKeys(tx, keys))
      : new Set<string>();
    for (const job of due) {
      let state = 'done',
        errorCode: string | undefined;
      try {
        abort.signal.throwIfAborted();
        const upload = uploadsById.get(job.uploadId);
        if (upload && upload.expiresAt.getTime() + 60000 > now())
          throw new AppError(409, `${owner.errorPrefix}_UPLOAD_ACTIVE`, 'Upload remains active.');
        if (upload) {
          if (!owner.allowsCleanupKey(upload.objectKey) || referenced.has(upload.objectKey))
            state = 'retained';
          else {
            await store.remove(
              upload.objectKey,
              AbortSignal.any([abort.signal, AbortSignal.timeout(7000)]),
            );
            await db
              .get('writer')
              .update(uploads)
              .set({ state: 'cleaned' })
              .where(eq(uploads.id, upload.id));
          }
        }
      } catch {
        state = job.attempts >= 10 ? 'failed' : 'pending';
        errorCode = `${owner.errorPrefix}_MEDIA_CLEANUP_UNCONFIRMED`;
      }
      const [acknowledged] = await db
        .get('writer')
        .update(jobs)
        .set({
          state,
          leaseToken: null,
          leaseUntil: null,
          availableAt: new Date(now() + Math.min(3600000, 1000 * 2 ** job.attempts)),
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.state, 'dispatching'),
            eq(jobs.leaseToken, job.leaseToken!),
          ),
        );
      if (acknowledged.affectedRows === 1)
        log({
          ...trace,
          eventId: `${trace.module}.${trace.resource}.cleanup.${state}`,
          eventInstanceId: crypto.randomUUID(),
          requestId: job.requestId,
          userId: job.ownerId,
          jobId: job.id,
          ...(errorCode ? { errorCode } : {}),
        });
    }
    return due.length;
  }
  return {
    runOnce() {
      active ??= batch().finally(() => {
        active = undefined;
      });
      return active;
    },
    async stop() {
      stopped = true;
      abort.abort();
      await active;
    },
  };
}
export async function retryOwnedImageCleanup(
  db: Databases,
  tables: ImageTables,
  prefix: string,
  id: string,
) {
  z.uuid().parse(id);
  const { jobs } = tables;
  return retryTransaction(() =>
    db.get('writer').transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1).for('update');
      if (!job)
        throw new AppError(
          404,
          `${prefix}_MEDIA_JOB_NOT_FOUND`,
          'This image cleanup job was not found.',
        );
      if (job.state !== 'failed')
        throw new AppError(
          409,
          `${prefix}_MEDIA_JOB_NOT_FAILED`,
          'Only an exhausted cleanup job can be requeued.',
        );
      await tx
        .update(jobs)
        .set({
          state: 'pending',
          attempts: 0,
          availableAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(jobs.id, id));
      return { jobId: job.id, requestId: job.requestId, userId: job.ownerId };
    }),
  );
}
