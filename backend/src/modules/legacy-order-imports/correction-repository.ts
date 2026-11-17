import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import type { Principal } from '../../domain/access.js';
import { identifier } from '../../domain/validation.js';
import { amount, minorUnits } from '../../domain/money.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import { authorizeLegacyOrderImport } from './authorization.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import { expectedFinancialPlanHash, financialImportHash } from './financial-adapter-crypto.js';
import {
  importDigest,
  openImportGroup,
  sealImportGroup,
  type ImportBinding,
} from './sealed-groups.js';
import { legacyOrderImports as jobs, legacyOrderImportRows as rows } from './schema.js';
import { currentCorrectionManager } from './correction-authority.js';
import {
  applyImportCorrection,
  correctedImportPlanHash,
  correctedOrderedRowsHash,
  correctionError,
} from './correction-domain.js';
import { importCorrections } from './correction-schema.js';
import { correctionCommands } from './correction-commands.js';
import {
  importCorrectionRecordProof as correctionProof,
  verifiedImportCorrectionRecord as verified,
} from './correction-evidence.js';
export { verifyImportCorrectionRow } from './correction-evidence.js';
import {
  importCorrectionBindingSchema,
  importCorrectionBoundarySchema,
  importCorrectionContract,
  importCorrectionInputSchema,
  importCorrectionReceiptSchema,
  importCorrectionReviewSchema,
  type ImportCorrectionBinding,
  type ImportCorrectionBoundaryPort,
  type ImportCorrectionInput,
  type ImportCorrectionReview,
} from './correction-contracts.js';

type Transaction = AdministrationTransaction;
type CorrectionRow = typeof importCorrections.$inferSelect;
export interface ImportCorrectionRepositoryOptions {
  secret: string;
  contract?: typeof importCorrectionContract;
  boundary?: ImportCorrectionBoundaryPort;
  clock?: () => number;
}

export function legacyOrderImportCorrections(
  db: Databases,
  config: Config,
  options: ImportCorrectionRepositoryOptions,
) {
  const now = options.clock ?? Date.now,
    commands = correctionCommands(options.secret),
    checks = checkInService(db, config),
    enabled =
      options.contract === importCorrectionContract &&
      Boolean(options.boundary) &&
      !config.DEMO_MODE,
    transact = <T>(work: (tx: Transaction) => Promise<T>) =>
      retryTransaction(() => db.get('writer').transaction(work));
  importDigest(options.secret, 'request', 'correction-configuration');
  async function lookupSuccessor(tx: Transaction, scope: ImportFinancialScope) {
    const [row] = await tx
      .select()
      .from(importCorrections)
      .where(eq(importCorrections.successorOperationId, scope.operationId))
      .limit(1)
      .for('share');
    if (!row) return null;
    const value = verified(row, options.secret),
      target = value.body.successor;
    if (
      target.actorId !== scope.actorId ||
      target.operationId !== scope.operationId ||
      target.storeId !== scope.storeId ||
      target.counterId !== scope.counterId
    )
      throw correctionError('ORDER_IMPORT_CORRECTION_SCOPE_CHANGED');
    return { row, ...value };
  }
  async function context(
    tx: Transaction,
    user: Principal,
    jobId: string,
    operationId: string,
    sessionId: string,
  ) {
    identifier.parse(user.id);
    z.uuid().parse(jobId);
    z.uuid().parse(operationId);
    z.uuid().parse(sessionId);
    const [anchor] = await tx
        .select({ actorId: jobs.actorId })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1),
      [candidate] = await tx
        .select({ storeId: rows.storeId, counterId: rows.counterId })
        .from(rows)
        .where(and(eq(rows.jobId, jobId), eq(rows.operationId, operationId)))
        .limit(1);
    if (!anchor || anchor.actorId !== user.id || !candidate)
      throw correctionError('ORDER_IMPORT_CORRECTION_NOT_FOUND', 404);
    // The existing upload owner is retained: blank-email rows must not switch to
    // another correcting manager's shadow customer.
    await checks.assertCheckIn(user.id, candidate.storeId, candidate.counterId, tx);
    await authorizeLegacyOrderImport(tx, user.id, [candidate]);
    const manager = await currentCorrectionManager(tx, user, sessionId, options.secret),
      [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).for('update'),
      [row] = await tx
        .select()
        .from(rows)
        .where(
          and(
            eq(rows.jobId, jobId),
            eq(rows.operationId, operationId),
            sql`OCTET_LENGTH(${rows.payload})<=342000`,
          ),
        )
        .limit(1)
        .for('update');
    if (
      !job ||
      job.actorId !== user.id ||
      !row ||
      row.storeId !== candidate.storeId ||
      row.counterId !== candidate.counterId
    )
      throw correctionError('ORDER_IMPORT_CORRECTION_SCOPE_CHANGED');
    const binding: ImportBinding = {
        jobId,
        operationId,
        actorId: job.actorId,
        storeId: row.storeId,
        counterId: row.counterId,
        sequence: row.sequence,
        kind: job.kind,
      },
      opened = openImportGroup(options.secret, binding, row.payload),
      scope = { actorId: job.actorId, operationId, storeId: row.storeId, counterId: row.counterId },
      previous = await lookupSuccessor(tx, scope),
      planHash = previous
        ? correctedImportPlanHash(options.secret, scope, opened.plan, previous.body)
        : expectedFinancialPlanHash(options.secret, scope, opened.plan);
    if (
      opened.group.firstRow !== row.firstRow ||
      (previous && previous.row.planHash !== planHash) ||
      (opened.group.details.manager_correction_id ?? null) !== (previous?.body.id ?? null)
    )
      throw correctionError('ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID');
    return { job, row, scope, ...opened, manager, planHash, previous };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  async function boundary(tx: Transaction, current: Context) {
    if (current.plan.kind !== 'offline')
      throw correctionError('ORDER_IMPORT_CORRECTION_KIND_UNSUPPORTED');
    if (
      current.row.state !== 'FAILED' ||
      current.row.orderId !== null ||
      current.row.receiptId !== null ||
      current.row.proofHash !== null ||
      current.row.businessDate !== null ||
      !options.boundary
    )
      throw correctionError('ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED');
    const value = importCorrectionBoundarySchema.parse(
      await options.boundary.inspectRejectedBoundary(tx, {
        scope: current.scope,
        plan: current.plan,
        planHash: current.planHash,
        ...(current.previous ? { correction: current.previous.body } : {}),
      }),
    );
    if (
      JSON.stringify(value.scope) !== JSON.stringify(current.scope) ||
      value.planHash !== current.planHash ||
      value.namespace !== 'pos-import-v1:' + current.scope.operationId ||
      value.rejectionCode !== current.row.errorCode ||
      value.rejectedAt > now()
    )
      throw correctionError('ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED');
    return value;
  }
  function reviewHash(current: Context, proof: Awaited<ReturnType<typeof boundary>>) {
    return financialImportHash(options.secret, 'manager-correction-review', {
      jobId: current.job.id,
      uploadHash: current.job.requestHash,
      operationId: current.row.operationId,
      encryptedGroupHash: financialImportHash(
        options.secret,
        'correction-original-group',
        current.row.payload,
      ),
      planHash: current.planHash,
      proof,
      manager: current.manager,
    });
  }
  async function existingForOriginal(tx: Transaction, operationId: string) {
    const [row] = await tx
      .select()
      .from(importCorrections)
      .where(eq(importCorrections.originalOperationId, operationId))
      .limit(1)
      .for('share');
    return row ? verified(row, options.secret) : null;
  }
  function commandScope(current: Context, id: string, requestId: string) {
    z.string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .parse(requestId);
    return {
      id,
      originalJobId: current.job.id,
      originalOperationId: current.row.operationId,
      managerId: current.job.actorId,
      uploadHash: current.job.requestHash,
      planHash: current.planHash,
      groupHash: financialImportHash(
        options.secret,
        'correction-original-group',
        current.row.payload,
      ),
      requestId,
      createdAt: now(),
    };
  }
  return {
    enabled,
    /** Coordinator/core seam: only server-persisted, sealed successor bindings. */
    async correctionForOperation(
      tx: Transaction,
      scope: ImportFinancialScope,
    ): Promise<ImportCorrectionBinding | null> {
      return (await lookupSuccessor(tx, scope))?.body ?? null;
    },
    async review(user: Principal, jobId: string, operationId: string, sessionId: string) {
      return transact(async (tx) => {
        const current = await context(tx, user, jobId, operationId, sessionId),
          existing = await existingForOriginal(tx, operationId);
        let blocker: ImportCorrectionReview['blocker'] = !enabled
            ? 'ORDER_IMPORT_CORRECTION_DISABLED'
            : null,
          proof: Awaited<ReturnType<typeof boundary>> | null = null;
        if (existing) blocker = 'ORDER_IMPORT_CORRECTION_ALREADY_CREATED';
        else if (current.previous && current.previous.body.depth >= 10)
          blocker = 'ORDER_IMPORT_CORRECTION_DEPTH_LIMIT';
        else if (current.plan.kind !== 'offline')
          blocker = 'ORDER_IMPORT_CORRECTION_KIND_UNSUPPORTED';
        else if (!blocker) {
          try {
            proof = await boundary(tx, current);
            blocker = !proof.calculation
              ? 'ORDER_IMPORT_CORRECTION_CALCULATION_REQUIRED'
              : !proof.calculation.profileQualified
                ? 'ORDER_IMPORT_CORRECTION_PROFILE_UNQUALIFIED'
                : null;
          } catch {
            blocker = 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED';
          }
        }
        return importCorrectionReviewSchema.parse({
          jobId,
          operationId,
          enabled,
          eligible: !blocker,
          blocker,
          reviewHash: proof && !blocker ? reviewHash(current, proof) : null,
          original: {
            sequence: current.row.sequence,
            firstRow: current.row.firstRow,
            state: current.row.state,
            errorCode: current.row.errorCode,
            kind: current.job.kind,
            storeId: current.row.storeId,
            counterId: current.row.counterId,
            businessDateTime: current.plan.createdAt,
            payment: current.plan.payment,
            lineValue: current.plan.originalTenderAmount,
            lines: current.group.lines.map((line) => ({
              row: line.row,
              productId: BigInt(line.productId.trim()).toString(),
              quantity: Number(line.quantity.trim()),
              unitPrice: amount(minorUnits(line.price.trim())),
            })),
          },
          calculation: proof?.calculation ?? null,
          successor: existing?.receipt ?? null,
        });
      });
    },
    async read(user: Principal, jobId: string, operationId: string, id: string, sessionId: string) {
      z.uuid().parse(id);
      return transact(async (tx) => {
        await context(tx, user, jobId, operationId, sessionId);
        const [row] = await tx
          .select()
          .from(importCorrections)
          .where(
            and(
              eq(importCorrections.id, id),
              eq(importCorrections.originalJobId, jobId),
              eq(importCorrections.originalOperationId, operationId),
              eq(importCorrections.managerId, user.id),
            ),
          )
          .limit(1)
          .for('share');
        if (!row) throw correctionError('ORDER_IMPORT_CORRECTION_NOT_FOUND', 404);
        return verified(row, options.secret).receipt;
      });
    },
    /** This fences the correction namespace only; it never declares the original source operation effect-free. */
    async readCommand(
      user: Principal,
      jobId: string,
      operationId: string,
      id: string,
      sessionId: string,
      requestId: string,
    ) {
      z.uuid().parse(id);
      return transact(async (tx) => {
        const current = await context(tx, user, jobId, operationId, sessionId),
          control = await commands.reserve(tx, commandScope(current, id, requestId)),
          [accepted] = await tx
            .select()
            .from(importCorrections)
            .where(eq(importCorrections.id, id))
            .limit(1)
            .for('share');
        if (accepted) {
          const known = verified(accepted, options.secret);
          if (
            accepted.managerId !== user.id ||
            accepted.originalJobId !== jobId ||
            accepted.originalOperationId !== operationId
          )
            throw correctionError('ORDER_IMPORT_CORRECTION_NOT_FOUND', 404);
          const value = { status: 'accepted' as const, receipt: known.receipt };
          if (!control.outcome) await commands.complete(tx, control.row, value);
          else if (
            control.outcome.status === 'accepted' &&
            JSON.stringify(control.outcome.receipt) !== JSON.stringify(known.receipt)
          )
            throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_EVIDENCE_INVALID');
          await currentCorrectionManager(tx, user, sessionId, options.secret);
          return value;
        }
        if (control.outcome?.status === 'accepted')
          throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_EVIDENCE_INVALID');
        if (control.outcome) {
          await currentCorrectionManager(tx, user, sessionId, options.secret);
          return control.outcome;
        }
        const outcome = await commands.complete(tx, control.row, {
          contract: 'pos-import-correction-command-v1',
          status: 'not-created',
          id,
          originalJobId: jobId,
          originalOperationId: operationId,
          managerId: user.id,
          recordedAt: control.row.createdAt,
          noSuccessorQueued: true,
          latePostsFenced: true,
        });
        await currentCorrectionManager(tx, user, sessionId, options.secret);
        return outcome;
      });
    },
    async create(
      user: Principal,
      jobId: string,
      operationId: string,
      raw: ImportCorrectionInput,
      sessionId: string,
      requestId: string,
    ) {
      const input = importCorrectionInputSchema.parse(raw);
      z.string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/)
        .parse(requestId);
      if (!enabled) throw correctionError('ORDER_IMPORT_CORRECTION_DISABLED', 503);
      const requestHash = financialImportHash(options.secret, 'manager-correction-request', {
        jobId,
        operationId,
        actorId: user.id,
        input,
      });
      return transact(async (tx) => {
        const current = await context(tx, user, jobId, operationId, sessionId),
          control = await commands.reserve(tx, commandScope(current, input.id, requestId)),
          [prior] = await tx
            .select()
            .from(importCorrections)
            .where(eq(importCorrections.id, input.id))
            .limit(1)
            .for('update');
        if (prior) {
          const retained = verified(prior, options.secret);
          if (
            prior.requestHash !== requestHash ||
            prior.managerId !== user.id ||
            prior.originalOperationId !== operationId ||
            prior.originalJobId !== jobId
          )
            throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_CHANGED');
          if (!control.outcome)
            await commands.complete(tx, control.row, {
              status: 'accepted',
              receipt: retained.receipt,
            });
          return retained.receipt;
        }
        if (control.outcome?.status === 'not-created')
          throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_FENCED');
        if (control.outcome)
          throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_EVIDENCE_INVALID');
        if (await existingForOriginal(tx, operationId))
          throw correctionError('ORDER_IMPORT_CORRECTION_ALREADY_CREATED');
        if (current.previous && current.previous.body.depth >= 10)
          throw correctionError('ORDER_IMPORT_CORRECTION_DEPTH_LIMIT');
        const proof = await boundary(tx, current);
        if (!proof.calculation)
          throw correctionError('ORDER_IMPORT_CORRECTION_CALCULATION_REQUIRED');
        if (!proof.calculation.profileQualified)
          throw correctionError('ORDER_IMPORT_CORRECTION_PROFILE_UNQUALIFIED');
        if (reviewHash(current, proof) !== input.reviewHash)
          throw correctionError('ORDER_IMPORT_CORRECTION_REVIEW_CHANGED');
        const proposed = applyImportCorrection(current.group, input),
          unchangedPrices = current.group.lines.every(
            (line) =>
              minorUnits(line.price.trim()) ===
              minorUnits(input.lines.find((value) => value.row === line.row)!.unitPrice),
          );
        if (!unchangedPrices)
          throw correctionError('ORDER_IMPORT_CORRECTION_PRICE_REVIEW_REQUIRED');
        if (
          (input.historicalTenderAmount === '0.00' || unchangedPrices) &&
          input.historicalTenderAmount !== proof.calculation.payable
        )
          throw correctionError('ORDER_IMPORT_CORRECTION_TENDER_MISMATCH');
        const attestedAt = now(),
          created = Temporal.PlainDateTime.from(proposed.plan.createdAt.replace(' ', 'T'))
            .toZonedDateTime(config.BUSINESS_TIMEZONE)
            .toInstant();
        if (created.epochMilliseconds > attestedAt)
          throw correctionError('ORDER_IMPORT_FUTURE_DATE');
        const successor = {
            jobId: input.successorJobId,
            actorId: user.id,
            operationId: input.successorOperationId,
            storeId: current.row.storeId,
            counterId: current.row.counterId,
          },
          binding = importCorrectionBindingSchema.parse({
            contract: importCorrectionContract,
            id: input.id,
            root: current.previous?.body.root ?? {
              jobId,
              operationId,
              uploadHash: current.job.requestHash,
            },
            previousCorrectionId: current.previous?.body.id ?? null,
            depth: (current.previous?.body.depth ?? 0) + 1,
            original: {
              jobId,
              operationId,
              actorId: user.id,
              uploadHash: current.job.requestHash,
              encryptedGroupHash: financialImportHash(
                options.secret,
                'correction-original-group',
                current.row.payload,
              ),
              planHash: current.planHash,
              sequence: current.row.sequence,
              firstRow: current.row.firstRow,
              boundary: proof,
            },
            successor,
            businessDateTime: proposed.plan.createdAt,
            payment: proposed.plan.payment,
            orderedRowsHash: correctedOrderedRowsHash(options.secret, proposed.group.lines),
            historicalTenderAmount: input.historicalTenderAmount,
            reason: 'historical-correction',
            manager: {
              id: user.id,
              ...current.manager,
              evidenceId: input.evidenceId,
              attestedAt,
              confirmHistoricalTender: true,
            },
          }),
          planHash = correctedImportPlanHash(options.secret, successor, proposed.plan, binding),
          receipt = importCorrectionReceiptSchema.parse({
            id: input.id,
            originalJobId: jobId,
            originalOperationId: operationId,
            successorJobId: successor.jobId,
            successorOperationId: successor.operationId,
            managerId: user.id,
            originalLineValue: current.plan.originalTenderAmount,
            correctedLineValue: proposed.plan.originalTenderAmount,
            historicalTenderAmount: input.historicalTenderAmount,
            recordedAt: attestedAt,
            requiresApproval: true,
            financialExecution: 'pending-approval',
          }),
          stamp = new Date(attestedAt).toISOString().slice(0, 23).replace('T', ' '),
          newBinding: ImportBinding = { ...successor, sequence: 1, kind: 'offline' },
          fields: Omit<CorrectionRow, 'proofHash'> = {
            id: input.id,
            originalJobId: jobId,
            originalOperationId: operationId,
            successorJobId: successor.jobId,
            successorOperationId: successor.operationId,
            managerId: user.id,
            requestHash,
            planHash,
            body: binding,
            receipt,
            requestId,
            createdAt: attestedAt,
          };
        if (
          [jobId, operationId, input.id, input.successorJobId, input.successorOperationId]
            .length !==
          new Set([jobId, operationId, input.id, input.successorJobId, input.successorOperationId])
            .size
        )
          throw correctionError('ORDER_IMPORT_CORRECTION_ID_REUSED');
        await tx
          .insert(importCorrections)
          .values({ ...fields, proofHash: correctionProof(fields, options.secret) });
        await tx.insert(jobs).values({
          id: successor.jobId,
          actorId: user.id,
          requestId,
          requestHash: financialImportHash(options.secret, 'correction-successor-job', {
            binding,
            planHash,
          }),
          kind: 'offline',
          state: 'QUEUED',
          totalOrders: 1,
          importedOrders: 0,
          failedOrders: 0,
          cancelledOrders: 0,
          errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED',
          claimToken: null,
          leaseUntil: null,
          createdAt: stamp,
          updatedAt: stamp,
        });
        await tx.insert(rows).values({
          jobId: successor.jobId,
          operationId: successor.operationId,
          sequence: 1,
          firstRow: current.row.firstRow,
          storeId: successor.storeId,
          counterId: successor.counterId,
          state: 'PENDING',
          payload: sealImportGroup(options.secret, newBinding, proposed.group),
          errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED',
          updatedAt: stamp,
        });
        await commands.complete(tx, control.row, { status: 'accepted', receipt });
        await currentCorrectionManager(tx, user, sessionId, options.secret);
        return receipt;
      });
    },
  };
}
