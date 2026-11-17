import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { readCustomerContactBinding } from '../../checkout/customer-contact-authority.js';
import { checkoutRepository } from '../../checkout/repository.js';
import { legacyOrderImports as jobs, legacyOrderImportRows as rows } from '../schema.js';
import { lockFinancialImportScope, currentImportClose } from '../financial-adapter-authority.js';
import { currentCorrectionManager } from '../correction-authority.js';
import { readFinancialImportRecord } from '../financial-adapter-record.js';
import { recoverImportCompletion } from '../financial-adapter-proof.js';
import { assertNativeImportOrder, settleNativeImport } from '../financial-adapter-writer.js';
import {
  financialImportHash,
  financialSourceHash,
  equalImportHash,
  importFinancialError,
} from '../financial-adapter-crypto.js';
import type { LegacyImportFinancialOptions } from '../financial-adapter-options.js';
import type { legacyImportFinancialJournal } from '../financial-adapter-journal.js';
import type {
  FinancialImportProfiles,
  FinancialImportProfileContext,
} from '../financial-adapter-profiles.js';
import type { LegacyImportFinancialTransport } from '../financial-adapter-transport.js';
import type { ImportFinancialResult, ImportFinancialScope } from '../financial-contracts.js';
import { financialTransaction } from '../screening-transactions.js';
import {
  importAuthoritySuccessionContract,
  successionApproveInputSchema,
  successionContinueInputSchema,
  successionEnvelopeSchema,
  successionGrantSchema,
  successionReceiptSchema,
  successionReviewSchema,
  successionContinuationSchema,
  type ImportAuthoritySuccessionPort,
  type ImportSuccessionContinuation,
  type ImportSuccessionEnvelope,
} from './contracts.js';
import {
  importAuthoritySuccessions,
  importAuthorityHeads,
  importAuthorityContinuations,
} from './schema.js';
import {
  verifySuccessionGrant,
  readSuccessionHead,
  successionRef,
  successionGrantProof,
  successionHeadProof,
  setActiveContinuation,
  claimSuccessionStage,
} from './ledger.js';
import { successionNativeEvidence } from './evidence.js';
import { registerSuccessionReadScope, installSuccessionExecution } from './execution.js';
export function legacyImportAuthoritySuccession(
  config: Config,
  db: Databases,
  options: LegacyImportFinancialOptions,
  ports: {
    journal: ReturnType<typeof legacyImportFinancialJournal>;
    profiles: FinancialImportProfiles;
    transport: LegacyImportFinancialTransport;
    read: (scope: ImportFinancialScope) => Promise<ImportFinancialResult | null>;
  },
): ImportAuthoritySuccessionPort {
  const clock = options.clock ?? Date.now,
    checks = checkInService(db, config),
    keys = { secret: options.secret, sourceAuthKey: options.sourceAuthKey },
    transaction = <T>(work: (tx: AdministrationTransaction) => Promise<T>) =>
      financialTransaction(db, true, work);
  const selected = () =>
    options.authoritySuccessionContract === importAuthoritySuccessionContract && !config.DEMO_MODE;
  const receipt = (
    row: typeof importAuthoritySuccessions.$inferSelect,
    envelope: ImportSuccessionEnvelope,
  ) =>
    successionReceiptSchema.parse({
      id: row.id,
      sequence: row.sequence,
      jobId: row.jobId,
      operationId: row.operationId,
      orderId: envelope.data.orderId,
      managerId: row.managerId,
      issuedAt: envelope.data.issuedAt,
      expiresAt: envelope.data.expiresAt,
      reviewHash: envelope.data.evidenceHash,
    });
  async function hint(jobId: string, operationId: string) {
    z.uuid().parse(jobId);
    z.uuid().parse(operationId);
    const [value] = await db
      .get('writer')
      .select({ actorId: jobs.actorId, storeId: rows.storeId, counterId: rows.counterId })
      .from(rows)
      .innerJoin(jobs, eq(jobs.id, rows.jobId))
      .where(and(eq(rows.jobId, jobId), eq(rows.operationId, operationId)))
      .limit(1);
    if (!value) throw importFinancialError('ORDER_IMPORT_SUCCESSION_NOT_FOUND', 404);
    return {
      actorId: value.actorId,
      operationId,
      storeId: value.storeId,
      counterId: value.counterId,
    };
  }
  async function context(
    tx: AdministrationTransaction,
    user: Principal,
    jobId: string,
    scope: ImportFinancialScope,
    sessionId: string,
    full = true,
  ) {
    // Current manager prefix only. The old actor is immutable evidence, never a
    // principal to synthesize or a row to acquire after Store.
    const manager = await lockFinancialImportScope(tx, { ...scope, actorId: user.id });
    await checks.assertCheckIn(user.id, scope.storeId, scope.counterId, tx);
    const managerSession = await currentCorrectionManager(tx, user, sessionId, options.secret);
    const [job] = await tx
        .select({ actorId: jobs.actorId })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for('share'),
      [row] = await tx
        .select()
        .from(rows)
        .where(and(eq(rows.jobId, jobId), eq(rows.operationId, scope.operationId)))
        .limit(1)
        .for('share');
    if (
      !job ||
      !row ||
      job.actorId !== scope.actorId ||
      row.storeId !== scope.storeId ||
      row.counterId !== scope.counterId
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_NOT_FOUND', 404);
    registerSuccessionReadScope(tx, scope);
    const loaded = await readFinancialImportRecord(tx, scope, options.secret);
    if (!loaded) throw importFinancialError('ORDER_IMPORT_SUCCESSION_SOURCE_REQUIRED');
    const completed = await recoverImportCompletion(tx, loaded, options.secret);
    if (completed) return { loaded, row, manager, managerSession, completed };
    if (!full) return { loaded, row, manager, managerSession, completed: null };
    if (
      !['STARTING', 'RECONCILING'].includes(row.state) ||
      ['completed', 'rejected'].includes(loaded.state.status)
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_SOURCE_REQUIRED');
    const close = await currentImportClose(tx, scope, loaded.plan.createdAt.slice(0, 10));
    await ports.profiles.lock(tx, loaded);
    const contact = await readCustomerContactBinding(tx, loaded.state.authority.customerId),
      authority = {
        ...manager,
        customerId: loaded.state.authority.customerId,
        contact,
        close,
        approvalId: null,
      };
    return { loaded, row, manager, managerSession, completed: null, authority };
  }
  async function checked(
    tx: AdministrationTransaction,
    value: Awaited<ReturnType<typeof context>>,
  ) {
    if (value.completed) return null;
    const evidence = await successionNativeEvidence(tx, value.loaded.state, options),
      phase = evidence.confirmation ? 'settled' : 'staged',
      expected = await ports.profiles.expectedQuantities(tx, value.loaded, evidence.order, phase),
      benefits = await ports.profiles.qualifiedBenefits(tx, value.loaded, evidence.order, phase);
    await ports.profiles.sourceReceipt(tx, value.loaded, evidence.order);
    const native = await assertNativeImportOrder(
      tx,
      value.loaded.state,
      value.loaded.plan,
      evidence.order,
      expected,
      benefits,
      phase,
    );
    if (
      !evidence.settlement &&
      (Number(native.mapping.offline_payment ?? 0) !== 0 ||
        Number(native.mapping.online_payment ?? 0) !== 0 ||
        Number(native.mapping.online_other_payment ?? 0) !== 0 ||
        native.header.paymentStatus !==
          (value.loaded.plan.kind === 'shopify' || evidence.confirmation ? 1n : 0n) ||
        native.header.status !==
          (value.loaded.plan.kind === 'shopify' || evidence.confirmation ? 1n : 0n))
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PAYMENT_UNKNOWN');
    return evidence;
  }
  async function reviewIn(
    tx: AdministrationTransaction,
    user: Principal,
    jobId: string,
    scope: ImportFinancialScope,
    sessionId: string,
  ) {
    const value = await context(tx, user, jobId, scope, sessionId);
    if (value.completed)
      return {
        value,
        evidence: null,
        head: null,
        review: successionReviewSchema.parse({
          contract: importAuthoritySuccessionContract,
          jobId,
          operationId: scope.operationId,
          orderId: value.completed.order.orderId,
          storeId: scope.storeId,
          counterId: scope.counterId,
          originalActorId: scope.actorId,
          currentManagerId: user.id,
          businessDate: value.completed.businessDate,
          payable: value.completed.order.payable,
          kind: value.loaded.plan.kind,
          status: 'completed',
          code: null,
          next: null,
          head: null,
          reviewHash: financialImportHash(options.secret, 'succession-completed', value.completed),
          grant: null,
        }),
      };
    if (!selected() && !value.loaded.state.authoritySuccession)
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_DISABLED', 503);
    const evidence = await checked(tx, value);
    if (!evidence || !value.authority)
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_SOURCE_REQUIRED');
    const head = await readSuccessionHead(tx, value.loaded.state, keys);
    const reviewHash = financialImportHash(options.secret, 'authority-succession-review', {
      jobId,
      scope,
      authority: value.authority,
      evidence: evidence.evidenceHash,
      head: head ? successionRef(head.envelope) : null,
    });
    const review = successionReviewSchema.parse({
      contract: importAuthoritySuccessionContract,
      jobId,
      operationId: scope.operationId,
      orderId: evidence.order.orderId,
      storeId: scope.storeId,
      counterId: scope.counterId,
      originalActorId: scope.actorId,
      currentManagerId: user.id,
      businessDate: value.loaded.plan.createdAt.slice(0, 10),
      payable: evidence.order.payable,
      kind: value.loaded.plan.kind,
      status: evidence.code || !evidence.next ? 'blocked' : 'ready',
      code: evidence.code ?? (!evidence.next ? 'ORDER_IMPORT_SUCCESSION_RECONCILE_REQUIRED' : null),
      next: evidence.next,
      head: head ? successionRef(head.envelope) : null,
      reviewHash,
      grant: head ? receipt(head.row, head.envelope) : null,
    });
    return { value, evidence, head, review };
  }
  async function readGrant(
    tx: AdministrationTransaction,
    value: Awaited<ReturnType<typeof context>>,
    jobId: string,
    commandId: string,
  ) {
    const [row] = await tx
      .select()
      .from(importAuthoritySuccessions)
      .where(eq(importAuthoritySuccessions.id, z.uuid().parse(commandId)))
      .limit(1)
      .for('share');
    if (!row) return null;
    if (row.jobId !== jobId || row.operationId !== value.loaded.state.scope.operationId)
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_NOT_FOUND', 404);
    return { row, envelope: verifySuccessionGrant(row, value.loaded.state, keys, false) };
  }
  function verifyContinuation(
    row: typeof importAuthorityContinuations.$inferSelect,
    state: FinancialImportProfileContext['state'],
    jobId: string,
  ) {
    const data = successionContinuationSchema.parse(row.data),
      { proofHash, ...body } = row;
    if (
      data.commandId !== row.id ||
      data.grantId !== row.grantId ||
      data.jobId !== jobId ||
      data.operationId !== state.scope.operationId ||
      row.operationId !== state.scope.operationId ||
      !equalImportHash(
        proofHash,
        financialImportHash(options.secret, 'authority-continuation', body),
      )
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
    return data;
  }
  async function updateContinuation(
    tx: AdministrationTransaction,
    row: typeof importAuthorityContinuations.$inferSelect,
    data: ImportSuccessionContinuation,
  ) {
    const next = successionContinuationSchema.parse(data),
      body = { ...row, data: next };
    const { proofHash: _proof, ...fields } = body;
    await tx
      .update(importAuthorityContinuations)
      .set({
        data: next,
        proofHash: financialImportHash(options.secret, 'authority-continuation', fields),
      })
      .where(eq(importAuthorityContinuations.id, row.id));
    return next;
  }
  async function execution(
    tx: AdministrationTransaction,
    user: Principal,
    jobId: string,
    scope: ImportFinancialScope,
    sessionId: string,
    grantId: string,
    commandId: string,
  ) {
    const value = await context(tx, user, jobId, scope, sessionId);
    if (value.completed) return { ...value, envelope: null };
    const head = await readSuccessionHead(tx, value.loaded.state, keys);
    if (
      !selected() ||
      !head ||
      head.envelope.data.id !== grantId ||
      head.envelope.data.managerId !== user.id ||
      head.envelope.data.expiresAt <= clock() ||
      head.envelope.data.issuedAt > clock() ||
      head.row.managerSessionId !== sessionId ||
      head.head.activeCommandId !== commandId ||
      !value.authority
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_AUTHORITY_CHANGED');
    const expected = head.envelope.data.authority;
    if (
      expected.actorVersion !== value.authority.actorVersion ||
      expected.actorEpoch !== value.authority.actorEpoch ||
      JSON.stringify(expected.contact) !== JSON.stringify(value.authority.contact)
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_AUTHORITY_CHANGED');
    installSuccessionExecution(tx, {
      scope: scope,
      original: value.loaded.state.authority,
      grant: head.envelope,
      clock,
    });
    return { ...value, envelope: head.envelope };
  }
  async function run(
    user: Principal,
    jobId: string,
    scope: ImportFinancialScope,
    sessionId: string,
    commandId: string,
    grantId: string,
  ) {
    try {
      for (let step = 0; step < 3; step++) {
        const task = await transaction(async (tx) => {
          const value = await execution(tx, user, jobId, scope, sessionId, grantId, commandId);
          if (value.completed || !value.envelope) return null;
          const evidence = await checked(tx, value);
          if (!evidence || evidence.code)
            throw importFinancialError(evidence?.code ?? 'ORDER_IMPORT_SUCCESSION_SOURCE_REQUIRED');
          if (!evidence.next) return null;
          ports.transport.assertReady();
          if (
            evidence.next !== 'publication' &&
            JSON.stringify(value.authority?.close) !==
              JSON.stringify(value.envelope.data.authority.close)
          )
            throw importFinancialError('ORDER_IMPORT_SUCCESSION_PERIOD_CHANGED');
          const claimed = await claimSuccessionStage(
            tx,
            value.loaded.state,
            value.envelope,
            commandId,
            evidence.next,
            keys,
            clock(),
          );
          if (!claimed) throw importFinancialError('ORDER_IMPORT_SUCCESSION_ORIGINAL_UNKNOWN');
          const state = {
            ...value.loaded.state,
            status: 'running' as const,
            stage: evidence.next,
            orderId: evidence.order.orderId,
            updatedAt: clock(),
          };
          await ports.journal.save(tx, state);
          await ports.profiles.dispatch(tx, { ...value.loaded, state }, evidence.next);
          if (evidence.next === 'settlement') {
            if (
              JSON.stringify(value.authority?.close) !==
              JSON.stringify(value.envelope.data.authority.close)
            )
              throw importFinancialError('ORDER_IMPORT_SUCCESSION_PERIOD_CHANGED');
            const expected = await ports.profiles.expectedQuantities(
                tx,
                { ...value.loaded, state },
                evidence.order,
                'settled',
              ),
              benefits = await ports.profiles.qualifiedBenefits(
                tx,
                { ...value.loaded, state },
                evidence.order,
                'settled',
              ),
              settlement = await settleNativeImport(
                tx,
                state,
                value.loaded.plan,
                evidence.order,
                options,
                expected,
                benefits,
              );
            await ports.journal.confirm(tx, state, 'settlement', settlement);
            return { kind: 'settlement' as const };
          }
          return {
            kind: evidence.next,
            command: { state, plan: value.loaded.plan, ...claimed },
            order: evidence.order,
          };
        });
        if (!task) break;
        if (task.kind === 'confirmation') {
          const customer = await checkoutRepository(db).customer(
            task.command.state.authority.customerId,
            'writer',
          );
          if (!customer) throw importFinancialError('ORDER_IMPORT_CUSTOMER_UNAVAILABLE');
          await ports.transport.confirm(task.command, task.order, customer);
        } else if (task.kind === 'publication') {
          await ports.transport.publication(task.command, task.order);
          break;
        }
      }
    } catch {
      /* Original factual receipts are reconciled below; never redispatch here. */
    }
    const result = await ports.read(scope).catch(() => null);
    return transaction(async (tx) => {
      const loaded = await ports.journal.load(tx, scope),
        [row] = await tx
          .select()
          .from(importAuthorityContinuations)
          .where(eq(importAuthorityContinuations.id, commandId))
          .limit(1)
          .for('update');
      if (!loaded || !row || row.managerId !== user.id || row.grantId !== grantId)
        throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
      const prior = verifyContinuation(row, loaded.state, jobId);
      return updateContinuation(tx, row, {
        ...prior,
        status: result?.status === 'completed' ? 'completed' : 'unknown',
        stage:
          result?.status === 'unknown' && result.stage !== 'order' && result.stage !== 'preparation'
            ? result.stage
            : prior.stage,
        result:
          result?.status === 'completed'
            ? {
                operationId: result.operationId,
                orderId: result.orderId,
                receiptId: result.receiptId,
                businessDate: result.businessDate,
                projectionHash: result.projectionHash,
              }
            : null,
        updatedAt: clock(),
      });
    });
  }
  return {
    async review(user, jobId, operationId, sessionId) {
      const scope = await hint(jobId, operationId);
      return transaction(async (tx) => (await reviewIn(tx, user, jobId, scope, sessionId)).review);
    },
    async approve(user, jobId, operationId, supplied, sessionId, requestId) {
      const input = successionApproveInputSchema.parse(supplied),
        scope = await hint(jobId, operationId);
      return transaction(async (tx) => {
        const initial = await context(tx, user, jobId, scope, sessionId, false),
          prior = await readGrant(tx, initial, jobId, input.commandId),
          commandHash = financialImportHash(options.secret, 'authority-succession-command', {
            jobId,
            scope,
            actorId: user.id,
            ...input,
          });
        if (prior) {
          if (prior.row.commandHash !== commandHash || prior.row.managerId !== user.id)
            throw importFinancialError('ORDER_IMPORT_SUCCESSION_COMMAND_REUSED');
          return receipt(prior.row, prior.envelope);
        }
        if (!selected()) throw importFinancialError('ORDER_IMPORT_SUCCESSION_DISABLED', 503);
        ports.transport.assertReady();
        const checkedValue = await reviewIn(tx, user, jobId, scope, sessionId),
          { review, value, evidence, head } = checkedValue;
        if (
          review.status !== 'ready' ||
          !evidence ||
          !value.authority ||
          review.reviewHash !== input.reviewHash
        )
          throw importFinancialError(review.code ?? 'ORDER_IMPORT_SUCCESSION_REVIEW_CHANGED');
        const issuedAt = clock(),
          data = successionGrantSchema.parse({
            contract: importAuthoritySuccessionContract,
            id: input.commandId,
            sequence: (head?.envelope.data.sequence ?? 0) + 1,
            previous: head ? successionRef(head.envelope) : null,
            originalScope: scope,
            requestHash: value.loaded.state.requestHash,
            planHash: value.loaded.state.planHash,
            namespace: value.loaded.state.namespace,
            originalAuthorityHash: financialSourceHash(
              options.sourceAuthKey ?? '',
              'succession-original-authority',
              value.loaded.state.authority,
            ),
            orderId: evidence.order.orderId,
            sourceReceiptHash: evidence.sourceReceiptHash,
            headerHash: evidence.order.headerHash,
            lineHash: evidence.order.lineHash,
            evidenceHash: input.reviewHash,
            managerId: user.id,
            requestId,
            sessionHash: value.managerSession.sessionHash,
            sessionDigest: createHash('sha256').update(sessionId).digest('hex'),
            authority: value.authority,
            businessDate: value.loaded.plan.createdAt.slice(0, 10),
            reason: input.reason,
            reviewedAt: issuedAt,
            issuedAt,
            expiresAt: issuedAt + 3600000,
          }),
          envelope = successionEnvelopeSchema.parse({
            data,
            sourceHash: financialSourceHash(
              options.sourceAuthKey ?? '',
              'authority-succession',
              data,
            ),
          }),
          fields = {
            id: input.commandId,
            operationId,
            sequence: data.sequence,
            jobId,
            managerId: user.id,
            managerSessionId: sessionId,
            commandHash,
            data: envelope,
            createdAt: issuedAt,
          };
        await tx
          .insert(importAuthoritySuccessions)
          .values({ ...fields, proofHash: successionGrantProof(fields, options.secret) });
        const headFields = {
          operationId,
          grantId: data.id,
          sequence: data.sequence,
          sourceHash: envelope.sourceHash,
          activeCommandId: null,
        };
        await tx
          .insert(importAuthorityHeads)
          .values({ ...headFields, proofHash: successionHeadProof(headFields, options.secret) })
          .onDuplicateKeyUpdate({
            set: { ...headFields, proofHash: successionHeadProof(headFields, options.secret) },
          });
        if (evidence.confirmation)
          await ports.profiles.captureConsumedReferences(tx, value.loaded, evidence.order, {
            id: data.id,
            managerId: data.managerId,
            issuedAt: data.issuedAt,
          });
        await ports.journal.save(tx, {
          ...value.loaded.state,
          authoritySuccession: successionRef(envelope),
          orderId: evidence.order.orderId,
          updatedAt: issuedAt,
        });
        void requestId;
        return receipt(
          { ...fields, proofHash: successionGrantProof(fields, options.secret) },
          envelope,
        );
      });
    },
    async readApproval(user, jobId, operationId, commandId, sessionId) {
      const scope = await hint(jobId, operationId);
      return transaction(async (tx) => {
        const value = await context(tx, user, jobId, scope, sessionId, false),
          grant = await readGrant(tx, value, jobId, commandId);
        return grant ? receipt(grant.row, grant.envelope) : null;
      });
    },
    async continue(user, jobId, operationId, supplied, sessionId, requestId) {
      const input = successionContinueInputSchema.parse(supplied),
        scope = await hint(jobId, operationId);
      const saved = await transaction(async (tx) => {
        const value = await context(tx, user, jobId, scope, sessionId, false),
          [prior] = await tx
            .select()
            .from(importAuthorityContinuations)
            .where(eq(importAuthorityContinuations.id, input.commandId))
            .limit(1)
            .for('update'),
          requestHash = financialImportHash(options.secret, 'authority-continuation-request', {
            jobId,
            scope,
            managerId: user.id,
            ...input,
          });
        if (prior) {
          if (prior.requestHash !== requestHash || prior.managerId !== user.id)
            throw importFinancialError('ORDER_IMPORT_SUCCESSION_COMMAND_REUSED');
          return { receipt: verifyContinuation(prior, value.loaded.state, jobId), send: false };
        }
        if (!selected() || value.completed)
          throw importFinancialError('ORDER_IMPORT_SUCCESSION_AUTHORITY_CHANGED');
        const grant = await readSuccessionHead(tx, value.loaded.state, keys);
        if (
          !grant ||
          grant.envelope.data.id !== input.grantId ||
          grant.envelope.data.managerId !== user.id ||
          grant.envelope.data.expiresAt <= clock()
        )
          throw importFinancialError('ORDER_IMPORT_SUCCESSION_AUTHORITY_CHANGED');
        await setActiveContinuation(tx, value.loaded.state, keys, input.commandId);
        const data = successionContinuationSchema.parse({
            commandId: input.commandId,
            grantId: input.grantId,
            jobId,
            operationId,
            status: 'started',
            stage: null,
            orderId: grant.envelope.data.orderId,
            result: null,
            createdAt: clock(),
            updatedAt: clock(),
          }),
          fields = {
            id: input.commandId,
            operationId,
            grantId: input.grantId,
            managerId: user.id,
            requestHash,
            data,
          };
        await tx.insert(importAuthorityContinuations).values({
          ...fields,
          proofHash: financialImportHash(options.secret, 'authority-continuation', fields),
        });
        void requestId;
        return { receipt: data, send: true };
      });
      return saved.send
        ? run(user, jobId, scope, sessionId, input.commandId, input.grantId)
        : saved.receipt;
    },
    async readContinuation(user, jobId, operationId, commandId, sessionId) {
      const scope = await hint(jobId, operationId);
      await transaction(async (tx) => {
        const value = await context(tx, user, jobId, scope, sessionId, false),
          [saved] = await tx
            .select()
            .from(importAuthorityContinuations)
            .where(eq(importAuthorityContinuations.id, z.uuid().parse(commandId)))
            .limit(1)
            .for('share');
        if (saved) verifyContinuation(saved, value.loaded.state, jobId);
      });
      const result = await ports.read(scope).catch(() => null);
      return transaction(async (tx) => {
        const value = await context(tx, user, jobId, scope, sessionId, false),
          [row] = await tx
            .select()
            .from(importAuthorityContinuations)
            .where(eq(importAuthorityContinuations.id, z.uuid().parse(commandId)))
            .limit(1)
            .for('update');
        if (!row) return null;
        const prior = verifyContinuation(row, value.loaded.state, jobId);
        if (result?.status !== 'completed' || prior.status === 'completed') return prior;
        return updateContinuation(tx, row, {
          ...prior,
          status: 'completed',
          stage: 'publication',
          result: {
            operationId: result.operationId,
            orderId: result.orderId,
            receiptId: result.receiptId,
            businessDate: result.businessDate,
            projectionHash: result.projectionHash,
          },
          updatedAt: clock(),
        });
      });
    },
  };
}
