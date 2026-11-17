import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
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
  openFinancialPlan,
  equalImportHash,
  importFinancialError,
} from './financial-adapter-crypto.js';
import { legacyOrderImportFinancialApprovals } from './financial-adapter-approval.js';
import {
  assertFinancialImportAuthority,
  lockFinancialImportScope,
} from './financial-adapter-authority.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
export function legacyImportFinancialJournal(
  config: Config,
  db: Databases,
  options: { secret: string; clock?: () => number },
) {
  const now = options.clock ?? Date.now,
    approvals = legacyOrderImportFinancialApprovals(config, db, options);
  async function load(tx: AdministrationTransaction, scope: ImportFinancialScope) {
    const boundScope = financialImportScopeSchema.parse({
      actorId: scope.actorId,
      operationId: scope.operationId,
      storeId: scope.storeId,
      counterId: scope.counterId,
    });
    const [row] = await tx
      .select()
      .from(financialImportOperations)
      .where(eq(financialImportOperations.id, scope.operationId))
      .limit(1)
      .for('update');
    if (!row) return null;
    const state = importFinancialStateSchema.parse(row.state);
    if (
      row.actorId !== scope.actorId ||
      row.storeId !== scope.storeId ||
      row.counterId !== scope.counterId ||
      JSON.stringify(state.scope) !== JSON.stringify(boundScope) ||
      state.planHash !== row.planHash ||
      state.requestHash !== row.requestHash ||
      state.namespace !== row.namespace
    )
      throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
    const plan = openFinancialPlan(options.secret, boundScope, row.planHash, row.payload);
    if (
      !equalImportHash(
        state.requestHash,
        financialImportHash(options.secret, 'request', {
          scope: boundScope,
          planHash: state.planHash,
          plan,
          authority: state.authority,
        }),
      )
    )
      throw importFinancialError('ORDER_IMPORT_FINANCIAL_PAYLOAD_INVALID');
    return { state, plan };
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
      return retryTransaction(() => db.get('writer').transaction(work));
    },
    async reserve(input: ImportFinancialScope & { plan: LegacyOrderImportPlan; planHash: string }) {
      const { plan: raw, planHash, ...scope } = input;
      financialImportScopeSchema.parse(scope);
      if (!equalImportHash(expectedFinancialPlanHash(options.secret, scope, raw), planHash))
        throw importFinancialError('ORDER_IMPORT_PLAN_CHANGED');
      const plan = financialImportPlanSchema.parse(raw);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockFinancialImportScope(tx, scope);
          const existing = await load(tx, scope);
          if (existing) {
            if (existing.state.planHash !== planHash)
              throw importFinancialError('ORDER_IMPORT_PLAN_CHANGED');
            return { ...existing, created: false };
          }
          const access = await approvals.authorizeStart(tx, input);
          if (!access.ready) throw importFinancialError('ORDER_IMPORT_APPROVAL_REQUIRED');
          const requestHash = financialImportHash(options.secret, 'request', {
              scope,
              planHash,
              plan,
              authority: access.authority,
            }),
            time = now(),
            state = importFinancialStateSchema.parse({
              scope,
              planHash,
              requestHash,
              namespace: `pos-import-v1:${scope.operationId}`,
              authority: access.authority,
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
          return { state, plan, created: true };
        }),
      );
    },
    async dispatch(scope: ImportFinancialScope, kind: FinancialImportStage) {
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const loaded = await load(tx, scope);
          if (!loaded || loaded.state.status !== 'running')
            throw importFinancialError('ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN');
          await assertFinancialImportAuthority(tx, scope, loaded.state.authority);
          if (kind !== 'publication') {
            const authorization = await approvals.authorizeStart(tx, {
              ...scope,
              plan: loaded.plan,
              planHash: loaded.state.planHash,
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
        }),
      );
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
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const value = await load(tx, scope);
          if (!value) return;
          await save(tx, { ...value.state, status: 'unknown', updatedAt: now() });
        }),
      );
    },
  };
}
