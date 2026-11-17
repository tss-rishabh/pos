import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store } from '../../db/legacy-schema.js';
import { operatorAuthEpochs } from '../../auth/revocation.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  financialImportOperations,
  financialImportStages,
  financialImportReferences,
} from './financial-adapter-schema.js';
import {
  importFinancialStateSchema,
  financialImportPlanSchema,
  financialImportScopeSchema,
  type ImportFinancialState,
  type FinancialImportStage,
} from './financial-adapter-contracts.js';
import {
  financialImportHash,
  expectedFinancialPlanHash,
  sealFinancialPlan,
  financialImportRequestHash,
  equalImportHash,
  importFinancialError,
} from './financial-adapter-crypto.js';
import {
  legacyOrderImportFinancialApprovals,
  type FinancialApprovalOptions,
} from './financial-adapter-approval.js';
import { readFinancialImportRecord } from './financial-adapter-record.js';
import {
  assertFinancialImportAuthority,
  lockFinancialImportScope,
} from './financial-adapter-authority.js';
import type { ImportFinancialScope, ImportFinancialStart } from './financial-contracts.js';
import {
  financialAdapterProfiles,
  type FinancialImportProfiles,
} from './financial-adapter-profiles.js';
import {
  FinancialImportAdmissionDenied,
  recordNativeAdmissionRejection,
  verifiedNativeAdmissionRejection,
} from './financial-adapter-admission.js';
import { financialTransaction, financialSavepoint } from './screening-transactions.js';

/** Retained receipt reads lock scope without requiring the original actor to
 * remain active; current caller authorization stays at its existing boundary. */
export async function lockFinancialImportStore(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
) {
  const storeId = financialImportScopeSchema.shape.storeId.parse(scope.storeId);
  const actorId = financialImportScopeSchema.shape.actorId.parse(scope.actorId);
  await tx
    .select({ id: PosUser.id })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(actorId)))
    .limit(1)
    .for('share');
  await tx
    .select({ epoch: operatorAuthEpochs.epoch })
    .from(operatorAuthEpochs)
    .where(eq(operatorAuthEpochs.userId, actorId))
    .limit(1)
    .for('share');
  await tx
    .select({ id: Store.id })
    .from(Store)
    .where(eq(Store.id, BigInt(storeId)))
    .limit(1)
    .for('update');
}
export function legacyImportFinancialJournal(
  config: Config,
  db: Databases,
  options: FinancialApprovalOptions,
  profiles: FinancialImportProfiles = financialAdapterProfiles(),
) {
  const now = options.clock ?? Date.now,
    approvals = legacyOrderImportFinancialApprovals(config, db, options);
  const transaction = <T>(work: (tx: AdministrationTransaction) => Promise<T>) =>
    financialTransaction(db, profiles.currentScreeningReads, work);
  async function load(tx: AdministrationTransaction, scope: ImportFinancialScope) {
    const boundScope = financialImportScopeSchema.parse({
      actorId: scope.actorId,
      operationId: scope.operationId,
      storeId: scope.storeId,
      counterId: scope.counterId,
    });
    await lockFinancialImportStore(tx, boundScope);
    return readFinancialImportRecord(tx, boundScope, options.secret);
  }
  async function save(tx: AdministrationTransaction, state: ImportFinancialState) {
    importFinancialStateSchema.parse(state);
    await tx
      .update(financialImportOperations)
      .set({ state, updatedAt: state.updatedAt })
      .where(eq(financialImportOperations.id, state.scope.operationId));
  }
  return {
    approvals,
    load,
    save,
    transaction<T>(work: (tx: AdministrationTransaction) => Promise<T>) {
      return transaction(work);
    },
    async reserve(input: ImportFinancialStart) {
      const { plan: raw, planHash, correction } = input;
      const scope = financialImportScopeSchema.parse({
        actorId: input.actorId,
        operationId: input.operationId,
        storeId: input.storeId,
        counterId: input.counterId,
      });
      if (
        !equalImportHash(
          expectedFinancialPlanHash(options.secret, scope, raw, correction),
          planHash,
        )
      )
        throw importFinancialError('ORDER_IMPORT_PLAN_CHANGED');
      const plan = financialImportPlanSchema.parse(raw);
      return transaction(async (tx) => {
        await lockFinancialImportScope(tx, scope);
        const existing = await load(tx, scope);
        if (existing) {
          if (existing.state.planHash !== planHash)
            throw importFinancialError('ORDER_IMPORT_PLAN_CHANGED');
          const admission = await verifiedNativeAdmissionRejection(
            tx,
            existing.state,
            options.secret,
          );
          if (!admission) await profiles.lock(tx, existing);
          return { ...existing, created: false, admission };
        }
        profiles.assertReady(plan);
        const access = await approvals.authorizeStart(tx, input);
        if (!access.ready) throw importFinancialError('ORDER_IMPORT_APPROVAL_REQUIRED');
        const requestHash = financialImportRequestHash(options.secret, {
            scope,
            planHash,
            plan,
            authority: access.authority,
            ...(correction ? { correction } : {}),
          }),
          time = now(),
          state = importFinancialStateSchema.parse({
            scope,
            planHash,
            requestHash,
            namespace: `pos-import-v1:${scope.operationId}`,
            authority: access.authority,
            ...(correction ? { correction } : {}),
            status: 'running',
            stage: 'preparation',
            orderId: null,
            errorCode: null,
            requestId: currentRequestTrace()?.requestId ?? scope.operationId,
            createdAt: time,
            updatedAt: time,
          });
        if (plan.kind === 'shopify') {
          const reference = financialImportHash(options.secret, 'shopify-reference', {
            storeId: scope.storeId,
            reference: plan.reference,
          });
          await tx
            .insert(financialImportReferences)
            .values({ id: reference, operationId: scope.operationId, planHash })
            .onDuplicateKeyUpdate({ set: { id: reference } });
          const [claim] = await tx
            .select()
            .from(financialImportReferences)
            .where(eq(financialImportReferences.id, reference))
            .limit(1)
            .for('update');
          if (!claim || claim.operationId !== scope.operationId || claim.planHash !== planHash)
            throw importFinancialError('ORDER_IMPORT_DUPLICATE_SOURCE_REFERENCE');
        }
        await tx.insert(financialImportOperations).values({
          id: scope.operationId,
          actorId: scope.actorId,
          storeId: scope.storeId,
          counterId: scope.counterId,
          planHash,
          requestHash,
          namespace: state.namespace,
          payload: sealFinancialPlan(options.secret, scope, planHash, plan),
          state,
          createdAt: time,
          updatedAt: time,
        });
        // The original operation and all qualified reservations commit once.
        // A caller must not pre-reserve and then ask start() to dispatch again.
        if (profiles.needsReservation(plan)) {
          try {
            await financialSavepoint(tx, (savepoint) =>
              profiles.reserved(savepoint, { state, plan }),
            );
          } catch (error: unknown) {
            if (!(error instanceof FinancialImportAdmissionDenied)) throw error;
            const admission = await recordNativeAdmissionRejection(
              tx,
              state,
              error.code,
              options.secret,
              now(),
            );
            const rejected = {
              ...state,
              status: 'rejected' as const,
              errorCode: admission.code,
              updatedAt: now(),
            };
            await save(tx, rejected);
            return { state: rejected, plan, created: true, admission };
          }
        }
        return { state, plan, created: true, admission: null };
      });
    },
    async dispatch(scope: ImportFinancialScope, kind: FinancialImportStage) {
      scope = financialImportScopeSchema.parse({
        actorId: scope.actorId,
        operationId: scope.operationId,
        storeId: scope.storeId,
        counterId: scope.counterId,
      });
      return transaction(async (tx) => {
        const loaded = await load(tx, scope);
        if (!loaded || loaded.state.status !== 'running')
          throw importFinancialError('ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN');
        await assertFinancialImportAuthority(tx, scope, loaded.state.authority);
        if (kind !== 'publication') {
          const authorization = await approvals.authorizeStart(tx, {
            ...scope,
            plan: loaded.plan,
            planHash: loaded.state.planHash,
            ...(loaded.state.correction ? { correction: loaded.state.correction } : {}),
          });
          if (
            !authorization.ready ||
            !equalImportHash(
              financialImportHash(options.secret, 'dispatch-authority', authorization.authority),
              financialImportHash(options.secret, 'dispatch-authority', loaded.state.authority),
            )
          )
            throw importFinancialError('ORDER_IMPORT_APPROVAL_REQUIRED');
        }
        await profiles.dispatch(tx, loaded, kind);
        const id = `${scope.operationId}:${kind}`,
          [prior] = await tx
            .select()
            .from(financialImportStages)
            .where(eq(financialImportStages.id, id))
            .limit(1)
            .for('update');
        if (prior) throw importFinancialError('ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN');
        const nonce = crypto.randomUUID(),
          requestHash = financialImportHash(options.secret, 'stage', {
            scope,
            kind,
            requestHash: loaded.state.requestHash,
            nonce,
          }),
          time = now();
        await tx.insert(financialImportStages).values({
          id,
          operationId: scope.operationId,
          kind,
          nonce,
          status: 'dispatched',
          requestHash,
          proofHash: null,
          proof: null,
          createdAt: time,
          updatedAt: time,
        });
        const state = { ...loaded.state, stage: kind, updatedAt: time };
        await save(tx, state);
        return { ...loaded, state, nonce, issuedAt: time, expiresAt: time + 60000 };
      });
    },
    async confirm(
      tx: AdministrationTransaction,
      state: ImportFinancialState,
      kind: FinancialImportStage,
      proof: unknown,
    ) {
      await tx
        .update(financialImportStages)
        .set({
          status: 'confirmed',
          proofHash: financialImportHash(options.secret, 'stage-confirmation', {
            operationId: state.scope.operationId,
            kind,
            proof,
          }),
          proof,
          updatedAt: now(),
        })
        .where(
          and(
            eq(financialImportStages.operationId, state.scope.operationId),
            eq(financialImportStages.kind, kind),
            eq(financialImportStages.status, 'dispatched'),
          ),
        );
    },
    async uncertain(scope: ImportFinancialScope) {
      return transaction(async (tx) => {
        const value = await load(tx, scope);
        if (!value) return;
        await save(tx, { ...value.state, status: 'unknown', updatedAt: now() });
      });
    },
  };
}
