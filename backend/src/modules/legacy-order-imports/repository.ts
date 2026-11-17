import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { authorizeLegacyOrderImport, type ImportAuthorizer } from './authorization.js';
import {
  importFinancialResultSchema,
  importStartAuthorizationSchema,
  type ImportFinancialAdapter,
  type ImportFinancialResult,
  type ImportFinancialStart,
} from './financial-contracts.js';
import { prepareLegacyOrderImport } from './preparation.js';
import type { legacyOrderImportHistory, LegacyOrderImportHistoryAnchor } from './history.js';
import {
  importDigest,
  openImportGroup,
  sealImportGroup,
  type ImportBinding,
} from './sealed-groups.js';
import {
  legacyOrderImportRows as rows,
  legacyOrderImports as jobs,
  type LegacyImportJob,
  type LegacyImportRow,
} from './schema.js';

const terminalRows = ['IMPORTED', 'FAILED', 'CANCELLED'] as const;
const pendingRows = ['PENDING', 'STARTING', 'RECONCILING'] as const;
const leaseMilliseconds = 120000;
const missing = () =>
  new AppError(404, 'ORDER_IMPORT_NOT_FOUND', 'This order import is unavailable.');
function sqlTime(value: number) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}
function jobDto(job: LegacyImportJob) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    totalOrders: job.totalOrders,
    importedOrders: job.importedOrders,
    failedOrders: job.failedOrders,
    cancelledOrders: job.cancelledOrders,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}
function binding(job: LegacyImportJob, row: LegacyImportRow): ImportBinding {
  return {
    jobId: job.id,
    operationId: row.operationId,
    actorId: job.actorId,
    storeId: row.storeId,
    counterId: row.counterId,
    sequence: row.sequence,
    kind: job.kind,
  };
}
export interface LegacyImportRepositoryOptions {
  secret: string;
  now?: () => number;
  /** Production uses the native writer authorizer; fixtures can supply isolated authority. */
  authorize?: ImportAuthorizer;
  history?: Pick<ReturnType<typeof legacyOrderImportHistory>, 'detail' | 'results'>;
}
interface Claim {
  job: LegacyImportJob;
  row: LegacyImportRow;
  token: string;
  start: boolean;
}

export function legacyOrderImportRepository(db: Databases, options: LegacyImportRepositoryOptions) {
  const now = options.now ?? Date.now,
    authorize = options.authorize ?? authorizeLegacyOrderImport;
  // Validate the purpose key during construction, before a job can be staged.
  importDigest(options.secret, 'request', 'configuration');

  function financialInput(job: LegacyImportJob, row: LegacyImportRow): ImportFinancialStart {
    const scope = binding(job, row),
      { plan } = openImportGroup(options.secret, scope, row.payload);
    return {
      actorId: scope.actorId,
      operationId: scope.operationId,
      storeId: scope.storeId,
      counterId: scope.counterId,
      plan,
      planHash: importDigest(
        options.secret,
        'group',
        JSON.stringify(['pos-import-plan-v1', scope.actorId, scope.storeId, scope.counterId, plan]),
      ),
    };
  }

  async function owned(tx: AdministrationTransaction, actorId: string, id: string) {
    const [anchor] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!anchor || anchor.actorId !== actorId) throw missing();
    const scopes = await tx
      .selectDistinct({ storeId: rows.storeId, counterId: rows.counterId })
      .from(rows)
      .where(eq(rows.jobId, id))
      .orderBy(asc(rows.storeId))
      .limit(101);
    if (!scopes.length || scopes.length > 100)
      throw new AppError(
        409,
        'ORDER_IMPORT_STATE_INVALID',
        'This order import requires reconciliation.',
      );
    await authorize(tx, actorId, scopes);
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1).for('update');
    if (!job || job.actorId !== actorId) throw missing();
    return { job, scopes };
  }
  function historical(job: Pick<LegacyImportJob, 'completedAt'>) {
    if (!job.completedAt) return false;
    const completed = Date.parse(job.completedAt.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(completed))
      throw new AppError(
        409,
        'ORDER_IMPORT_STATE_INVALID',
        'The import completion time requires reconciliation.',
      );
    return completed < now() - 86400000;
  }
  function assertCurrentResult(job: Pick<LegacyImportJob, 'completedAt'>) {
    if (historical(job))
      throw new AppError(
        503,
        'ORDER_IMPORT_HISTORY_REQUIRED',
        'Historical import results require the published BigQuery reader.',
      );
  }
  function anchorIdentity(anchor: LegacyOrderImportHistoryAnchor) {
    const j = anchor.job;
    return JSON.stringify([
      String(j.sequence),
      j.id,
      j.actorId,
      j.requestHash,
      j.kind,
      j.state,
      j.totalOrders,
      j.importedOrders,
      j.failedOrders,
      j.cancelledOrders,
      j.errorCode,
      j.createdAt,
      j.updatedAt,
      j.completedAt,
      anchor.scopes.map((scope) => [scope.storeId, scope.counterId]),
    ]);
  }
  async function readOwned<T>(
    actor: string,
    id: string,
    current: (tx: AdministrationTransaction, job: LegacyImportJob) => Promise<T>,
    warehouse: (
      reader: NonNullable<LegacyImportRepositoryOptions['history']>,
      anchor: LegacyOrderImportHistoryAnchor,
    ) => Promise<T>,
  ): Promise<T> {
    const actorId = identifier.parse(actor);
    z.uuid().parse(id);
    const result = await db
      .get('writer')
      .transaction(
        async (
          tx,
        ): Promise<
          | { kind: 'current'; value: T }
          | { kind: 'historical'; anchor: LegacyOrderImportHistoryAnchor }
        > => {
          const anchor = await owned(tx, actorId, id);
          return historical(anchor.job)
            ? { kind: 'historical', anchor }
            : { kind: 'current', value: await current(tx, anchor.job) };
        },
      );
    if (result.kind === 'current') return result.value;
    if (!options.history) {
      assertCurrentResult(result.anchor.job);
      throw missing();
    }
    // Never hold native authorization/job locks while waiting for BigQuery.
    const response = await warehouse(options.history, result.anchor);
    await db.get('writer').transaction(async (tx) => {
      const latest = await owned(tx, actorId, id);
      if (anchorIdentity(latest) !== anchorIdentity(result.anchor))
        throw new AppError(
          409,
          'ORDER_IMPORT_HISTORY_CHANGED',
          'The import history changed while it was being read. Refresh the results.',
        );
    });
    return response;
  }
  async function finishJob(tx: AdministrationTransaction, job: LegacyImportJob, timestamp: string) {
    const [pending] = await tx
      .select({ sequence: rows.sequence })
      .from(rows)
      .where(and(eq(rows.jobId, job.id), inArray(rows.state, [...pendingRows])))
      .limit(1)
      .for('share');
    if (pending) return;
    const [current] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, job.id))
      .limit(1)
      .for('update');
    if (
      !current ||
      current.importedOrders + current.failedOrders + current.cancelledOrders !==
        current.totalOrders
    )
      throw new AppError(
        409,
        'ORDER_IMPORT_STATE_INVALID',
        'The import counters require reconciliation.',
      );
    const state =
      current.cancelledOrders > 0
        ? 'CANCELLED'
        : current.failedOrders === 0
          ? 'COMPLETED'
          : current.importedOrders === 0
            ? 'FAILED'
            : 'PARTIAL';
    await tx
      .update(jobs)
      .set({
        state,
        claimToken: null,
        leaseUntil: null,
        completedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(jobs.id, job.id));
  }

  async function claim(adapter: ImportFinancialAdapter): Promise<Claim | null> {
    return db.get('writer').transaction(async (tx) => {
      const timestamp = sqlTime(now()),
        [candidate] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              inArray(jobs.state, ['QUEUED', 'RUNNING']),
              or(isNull(jobs.leaseUntil), lte(jobs.leaseUntil, timestamp)),
            ),
          )
          .orderBy(asc(jobs.sequence))
          .limit(1);
      if (!candidate) return null;
      const [candidateRow] = await tx
        .select()
        .from(rows)
        .where(and(eq(rows.jobId, candidate.id), inArray(rows.state, [...pendingRows])))
        .orderBy(asc(rows.sequence))
        .limit(1);
      let authorized = false;
      if (candidateRow?.state === 'PENDING') {
        try {
          await authorize(tx, candidate.actorId, [
            { storeId: candidateRow.storeId, counterId: candidateRow.counterId },
          ]);
          authorized = true;
        } catch {
          // A current access failure only blocks a not-yet-started financial operation.
        }
      }
      const [job] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, candidate.id),
            inArray(jobs.state, ['QUEUED', 'RUNNING']),
            or(isNull(jobs.leaseUntil), lte(jobs.leaseUntil, timestamp)),
          ),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return null;
      const [row] = await tx
        .select()
        .from(rows)
        .where(and(eq(rows.jobId, job.id), inArray(rows.state, [...pendingRows])))
        .orderBy(asc(rows.sequence))
        .limit(1)
        .for('update');
      if (!row) {
        await finishJob(tx, job, timestamp);
        return null;
      }
      if (row.operationId !== candidateRow?.operationId) return null;
      if (row.state === 'PENDING' && !authorized) {
        await tx
          .update(jobs)
          .set({
            state: 'BLOCKED',
            errorCode: 'ORDER_IMPORT_ACCESS_CHANGED',
            claimToken: null,
            leaseUntil: null,
            updatedAt: timestamp,
          })
          .where(eq(jobs.id, job.id));
        return null;
      }
      let startInput: ImportFinancialStart | undefined;
      if (row.state === 'PENDING') {
        try {
          startInput = financialInput(job, row);
        } catch {
          await tx
            .update(jobs)
            .set({
              state: 'BLOCKED',
              errorCode: 'ORDER_IMPORT_PAYLOAD_INVALID',
              claimToken: null,
              leaseUntil: null,
              updatedAt: timestamp,
            })
            .where(eq(jobs.id, job.id));
          return null;
        }
      }
      if (startInput && adapter.authorizeStart) {
        const authorization = importStartAuthorizationSchema.parse(
          await adapter.authorizeStart(tx, startInput),
        );
        if (!authorization.ready) {
          await tx
            .update(rows)
            .set({ errorCode: authorization.code, updatedAt: timestamp })
            .where(and(eq(rows.jobId, job.id), eq(rows.sequence, row.sequence)));
          await tx
            .update(jobs)
            .set({
              errorCode: authorization.code,
              claimToken: null,
              leaseUntil: sqlTime(now() + 30000),
              updatedAt: timestamp,
            })
            .where(eq(jobs.id, job.id));
          return null;
        }
      }
      const token = randomUUID(),
        start = row.state === 'PENDING';
      await tx
        .update(rows)
        .set({ state: start ? 'STARTING' : 'RECONCILING', errorCode: null, updatedAt: timestamp })
        .where(and(eq(rows.jobId, job.id), eq(rows.sequence, row.sequence)));
      await tx
        .update(jobs)
        .set({
          state: 'RUNNING',
          errorCode: null,
          claimToken: token,
          leaseUntil: sqlTime(now() + leaseMilliseconds),
          updatedAt: timestamp,
        })
        .where(eq(jobs.id, job.id));
      return { job, row, token, start };
    });
  }
  async function retainResult(claimed: Claim, value: ImportFinancialResult | null) {
    return db.get('writer').transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, claimed.job.id))
        .limit(1)
        .for('update');
      if (!job || job.claimToken !== claimed.token) return null;
      const [row] = await tx
        .select()
        .from(rows)
        .where(and(eq(rows.jobId, job.id), eq(rows.sequence, claimed.row.sequence)))
        .limit(1)
        .for('update');
      if (!row || terminalRows.some((state) => state === row.state)) return null;
      const timestamp = sqlTime(now()),
        parsed = importFinancialResultSchema.safeParse(value);
      let result =
        parsed.success && parsed.data.operationId === row.operationId ? parsed.data : null;
      if (result?.status === 'completed') {
        const { plan } = openImportGroup(options.secret, binding(job, row), row.payload);
        if (result.businessDate !== plan.createdAt.slice(0, 10)) result = null;
      }
      if (result?.status === 'completed') {
        // A unique native order may only satisfy one immutable import operation.
        await tx
          .update(rows)
          .set({
            state: 'IMPORTED',
            orderId: result.orderId,
            receiptId: result.receiptId,
            businessDate: result.businessDate,
            proofHash: result.projectionHash,
            errorCode: null,
            updatedAt: timestamp,
          })
          .where(and(eq(rows.jobId, job.id), eq(rows.sequence, row.sequence)));
        await tx
          .update(jobs)
          .set({
            importedOrders: sql`${jobs.importedOrders}+1`,
            claimToken: null,
            leaseUntil: null,
            errorCode: null,
            updatedAt: timestamp,
          })
          .where(eq(jobs.id, job.id));
      } else if (result?.status === 'rejected') {
        await tx
          .update(rows)
          .set({ state: 'FAILED', errorCode: result.code, updatedAt: timestamp })
          .where(and(eq(rows.jobId, job.id), eq(rows.sequence, row.sequence)));
        await tx
          .update(jobs)
          .set({
            failedOrders: sql`${jobs.failedOrders}+1`,
            claimToken: null,
            leaseUntil: null,
            updatedAt: timestamp,
          })
          .where(eq(jobs.id, job.id));
      } else {
        await tx
          .update(rows)
          .set({
            state: 'RECONCILING',
            errorCode: 'ORDER_IMPORT_OUTCOME_UNCERTAIN',
            updatedAt: timestamp,
          })
          .where(and(eq(rows.jobId, job.id), eq(rows.sequence, row.sequence)));
        await tx
          .update(jobs)
          .set({
            claimToken: null,
            leaseUntil: sqlTime(now() + 30000),
            errorCode: 'ORDER_IMPORT_OUTCOME_UNCERTAIN',
            updatedAt: timestamp,
          })
          .where(eq(jobs.id, job.id));
      }
      await finishJob(tx, job, timestamp);
      return {
        jobId: job.id,
        operationId: row.operationId,
        actorId: job.actorId,
        requestId: job.requestId,
        sequence: row.sequence,
        state:
          result?.status === 'completed'
            ? 'IMPORTED'
            : result?.status === 'rejected'
              ? 'FAILED'
              : 'RECONCILING',
      };
    });
  }
  return {
    async stage(actor: string, request: string | undefined, value: unknown) {
      const actorId = identifier.parse(actor),
        requestId =
          request === undefined
            ? null
            : z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9._:-]+$/)
                .parse(request),
        prepared = prepareLegacyOrderImport(value),
        { input, groups, scopes, counters } = prepared,
        requestHash = importDigest(
          options.secret,
          'request',
          JSON.stringify([
            input.kind,
            input.kind === 'shopify' ? input.storeId : null,
            scopes,
            input.csv,
          ]),
        ),
        timestamp = sqlTime(now()),
        stagingToken = randomUUID();
      const records = groups.map((group): typeof rows.$inferInsert => {
        const storeId = prepared.plans[group.sequence - 1]!.storeId,
          counterId = counters.get(storeId)!,
          operationId = randomUUID(),
          scope: ImportBinding = {
            jobId: input.id,
            operationId,
            actorId,
            storeId,
            counterId,
            sequence: group.sequence,
            kind: input.kind,
          };
        return {
          jobId: input.id,
          sequence: group.sequence,
          firstRow: group.firstRow,
          operationId,
          storeId,
          counterId,
          state: 'PENDING',
          payload: sealImportGroup(options.secret, scope, group),
          updatedAt: timestamp,
        };
      });
      return db.get('writer').transaction(async (tx) => {
        await authorize(tx, actorId, scopes);
        await tx
          .insert(jobs)
          .values({
            id: input.id,
            actorId,
            requestId,
            requestHash,
            kind: input.kind,
            state: 'STAGING',
            totalOrders: records.length,
            importedOrders: 0,
            failedOrders: 0,
            cancelledOrders: 0,
            claimToken: stagingToken,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onDuplicateKeyUpdate({ set: { id: sql`${jobs.id}` } });
        const [job] = await tx
          .select()
          .from(jobs)
          .where(eq(jobs.id, input.id))
          .limit(1)
          .for('update');
        if (!job || job.actorId !== actorId) throw missing();
        if (job.requestHash !== requestHash)
          throw new AppError(
            409,
            'ORDER_IMPORT_COMMAND_CHANGED',
            'This import identifier is already bound to another file or scope.',
          );
        if (job.state !== 'STAGING') {
          assertCurrentResult(job);
          return jobDto(job);
        }
        if (job.claimToken !== stagingToken)
          throw new AppError(
            409,
            'ORDER_IMPORT_STATE_INVALID',
            'The import staging record requires reconciliation.',
          );
        let batch: typeof records = [],
          bytes = 0;
        for (const record of records) {
          if (batch.length && (batch.length >= 100 || bytes + record.payload.length > 1048576)) {
            await tx.insert(rows).values(batch);
            batch = [];
            bytes = 0;
          }
          batch.push(record);
          bytes += record.payload.length;
        }
        if (batch.length) await tx.insert(rows).values(batch);
        await tx
          .update(jobs)
          .set({ state: 'QUEUED', claimToken: null })
          .where(eq(jobs.id, input.id));
        return jobDto({ ...job, state: 'QUEUED', claimToken: null });
      });
    },
    async detail(actor: string, id: string) {
      return readOwned(
        actor,
        id,
        async (_tx, job) => jobDto(job),
        (history, anchor) => history.detail(anchor),
      );
    },
    async results(actor: string, id: string, after = 0, limit = 50) {
      z.number().int().min(0).max(50000).parse(after);
      z.number().int().min(1).max(100).parse(limit);
      return readOwned(
        actor,
        id,
        async (tx) => {
          return tx
            .select({
              sequence: rows.sequence,
              firstRow: rows.firstRow,
              operationId: rows.operationId,
              storeId: rows.storeId,
              counterId: rows.counterId,
              state: rows.state,
              orderId: rows.orderId,
              receiptId: rows.receiptId,
              businessDate: rows.businessDate,
              errorCode: rows.errorCode,
              updatedAt: rows.updatedAt,
            })
            .from(rows)
            .where(and(eq(rows.jobId, id), sql`${rows.sequence}>${after}`))
            .orderBy(asc(rows.sequence))
            .limit(limit)
            .for('share');
        },
        (history, anchor) => history.results(anchor, after, limit),
      );
    },
    async cancel(actor: string, id: string) {
      const actorId = identifier.parse(actor);
      z.uuid().parse(id);
      return db.get('writer').transaction(async (tx) => {
        const { job } = await owned(tx, actorId, id);
        assertCurrentResult(job);
        if (job.claimToken)
          throw new AppError(
            409,
            'ORDER_IMPORT_IN_FLIGHT',
            'Reconcile the active import operation before cancelling pending orders.',
          );
        if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(job.state)) return jobDto(job);
        const remaining = await tx
          .select({ sequence: rows.sequence, state: rows.state })
          .from(rows)
          .where(and(eq(rows.jobId, id), inArray(rows.state, [...pendingRows])))
          .for('update');
        if (remaining.some((row) => row.state !== 'PENDING'))
          throw new AppError(
            409,
            'ORDER_IMPORT_IN_FLIGHT',
            'Reconcile the active import operation before cancelling pending orders.',
          );
        const cancelled = remaining.length;
        if (!Number.isSafeInteger(cancelled) || cancelled < 0 || cancelled > 50000)
          throw new AppError(
            409,
            'ORDER_IMPORT_STATE_INVALID',
            'The import counters require reconciliation.',
          );
        await tx
          .update(rows)
          .set({ state: 'CANCELLED', updatedAt: sqlTime(now()) })
          .where(and(eq(rows.jobId, id), eq(rows.state, 'PENDING')));
        await tx
          .update(jobs)
          .set({ cancelledOrders: sql`${jobs.cancelledOrders}+${cancelled}` })
          .where(eq(jobs.id, id));
        await finishJob(tx, job, sqlTime(now()));
        const [current] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1);
        return jobDto(current!);
      });
    },
    /** Private approval input; never return this plan through an HTTP resource. */
    async financialContext(actor: string, id: string, operationId: string) {
      const actorId = identifier.parse(actor);
      z.uuid().parse(id);
      z.uuid().parse(operationId);
      return db.get('writer').transaction(async (tx) => {
        const { job } = await owned(tx, actorId, id);
        assertCurrentResult(job);
        const [row] = await tx
          .select()
          .from(rows)
          .where(and(eq(rows.jobId, id), eq(rows.operationId, operationId)))
          .limit(1)
          .for('share');
        if (!row || row.state !== 'PENDING')
          throw new AppError(
            409,
            'ORDER_IMPORT_APPROVAL_NOT_PENDING',
            'Only an unsent order can receive historical import approval.',
          );
        return financialInput(job, row);
      });
    },
    async runOne(adapter: ImportFinancialAdapter) {
      const claimed = await claim(adapter);
      if (!claimed) return null;
      let result: ImportFinancialResult | null = null;
      try {
        const scope = binding(claimed.job, claimed.row),
          financialScope = {
            actorId: scope.actorId,
            operationId: scope.operationId,
            storeId: scope.storeId,
            counterId: scope.counterId,
          };
        if (claimed.start) {
          result = await adapter.start(financialInput(claimed.job, claimed.row));
        } else {
          result = await adapter.read(financialScope);
        }
      } catch {
        // A throw can occur after a remote commit. Only read the original operation next.
      }
      return retainResult(claimed, result);
    },
  };
}
