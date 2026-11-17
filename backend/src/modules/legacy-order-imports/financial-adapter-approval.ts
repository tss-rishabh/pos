import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { contactActorVersion } from '../customer-contacts/authority.js';
import { assertCurrentInventoryAccess } from '../administration/authorization.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
import {
  captureFinancialImportAuthority,
  assertFinancialImportAuthority,
  currentImportClose,
  importNeedsPeriodApproval,
} from './financial-adapter-authority.js';
import {
  financialImportApprovalSchema,
  financialImportPlanSchema,
  financialImportScopeSchema,
  type FinancialImportAuthority,
  type FinancialImportApprovalView,
} from './financial-adapter-contracts.js';
import { financialImportApprovals, financialImportOperations } from './financial-adapter-schema.js';
import {
  financialImportHash,
  expectedFinancialPlanHash,
  equalImportHash,
  importFinancialError,
} from './financial-adapter-crypto.js';
export interface FinancialApprovalOptions {
  secret: string;
  clock?: () => number;
}
export interface FinancialApprovalInput {
  approverId: string;
  scope: ImportFinancialScope;
  plan: LegacyOrderImportPlan;
  planHash: string;
  commandId: string;
  reason: FinancialImportApprovalView['reason'];
}
export function verifyFinancialApprovalRow(
  row: typeof financialImportApprovals.$inferSelect,
  secret: string,
) {
  const data = financialImportApprovalSchema.parse(row.data);
  if (
    data.id !== row.id ||
    data.operationId !== row.operationId ||
    data.planHash !== row.planHash ||
    data.status !== 'approved' ||
    !equalImportHash(
      row.proofHash,
      financialImportHash(secret, 'approval', {
        data,
        authority: row.authority,
        approverVersion: row.approverVersion,
        requestHash: row.requestHash,
        commandId: row.commandId,
      }),
    )
  )
    throw importFinancialError('ORDER_IMPORT_APPROVAL_INVALID');
  return data;
}
export async function currentFinancialImportApproval(
  tx: AdministrationTransaction,
  secret: string,
  scope: ImportFinancialScope,
  planHash: string,
  authority: FinancialImportAuthority,
  now: number,
) {
  const rows = await tx
    .select()
    .from(financialImportApprovals)
    .where(
      and(
        eq(financialImportApprovals.operationId, scope.operationId),
        eq(financialImportApprovals.planHash, planHash),
      ),
    )
    .orderBy(desc(financialImportApprovals.createdAt), desc(financialImportApprovals.id))
    .limit(20)
    .for('share');
  for (const row of rows) {
    const data = verifyFinancialApprovalRow(row, secret);
    if (
      data.actorId !== scope.actorId ||
      data.storeId !== scope.storeId ||
      data.counterId !== scope.counterId ||
      data.expiresAt <= now ||
      data.issuedAt > now ||
      JSON.stringify(data.close) !== JSON.stringify(authority.close) ||
      !equalImportHash(
        financialImportHash(secret, 'approval-authority', row.authority),
        financialImportHash(secret, 'approval-authority', { ...authority, approvalId: null }),
      )
    )
      continue;
    try {
      await assertCurrentInventoryAccess(tx, data.approverId, scope.storeId);
      if (row.approverVersion !== (await contactActorVersion(tx, data.approverId))) continue;
    } catch {
      continue;
    }
    return data;
  }
  return null;
}
export function legacyOrderImportFinancialApprovals(
  config: Config,
  db: Databases,
  options: FinancialApprovalOptions,
) {
  const now = options.clock ?? Date.now;
  function validate(scope: ImportFinancialScope, plan: LegacyOrderImportPlan, planHash: string) {
    financialImportScopeSchema.parse(scope);
    financialImportPlanSchema.parse(plan);
    if (!equalImportHash(expectedFinancialPlanHash(options.secret, scope, plan), planHash))
      throw importFinancialError('ORDER_IMPORT_PLAN_CHANGED');
  }
  return {
    async request(input: FinancialApprovalInput): Promise<FinancialImportApprovalView> {
      validate(input.scope, input.plan, input.planHash);
      z.uuid().parse(input.commandId);
      const scope = input.scope;
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await assertCurrentInventoryAccess(tx, input.approverId, scope.storeId);
          const authority = await captureFinancialImportAuthority(
              tx,
              config,
              scope,
              input.plan,
              now(),
            ),
            approverVersion = await contactActorVersion(tx, input.approverId),
            requestHash = financialImportHash(options.secret, 'approval-request', {
              scope,
              planHash: input.planHash,
              approverId: input.approverId,
              reason: input.reason,
            });
          const [prior] = await tx
            .select()
            .from(financialImportApprovals)
            .where(eq(financialImportApprovals.commandId, input.commandId))
            .limit(1)
            .for('update');
          if (prior) {
            const data = verifyFinancialApprovalRow(prior, options.secret);
            if (prior.requestHash !== requestHash)
              throw importFinancialError('ORDER_IMPORT_APPROVAL_CONFLICT');
            const valid =
              data.expiresAt > now() &&
              prior.approverVersion === approverVersion &&
              equalImportHash(
                financialImportHash(options.secret, 'approval-authority', prior.authority),
                financialImportHash(options.secret, 'approval-authority', authority),
              );
            return { ...data, status: valid ? 'approved' : 'stale' };
          }
          const [started] = await tx
            .select({ id: financialImportOperations.id })
            .from(financialImportOperations)
            .where(eq(financialImportOperations.id, scope.operationId))
            .limit(1)
            .for('share');
          if (started) throw importFinancialError('ORDER_IMPORT_ALREADY_STARTED');
          const data = financialImportApprovalSchema.parse({
            id: crypto.randomUUID(),
            operationId: scope.operationId,
            actorId: scope.actorId,
            storeId: scope.storeId,
            counterId: scope.counterId,
            planHash: input.planHash,
            businessDate: input.plan.createdAt.slice(0, 10),
            approverId: input.approverId,
            reason: input.reason,
            issuedAt: now(),
            expiresAt: now() + 3600000,
            close: authority.close,
            status: 'approved',
          });
          const proofHash = financialImportHash(options.secret, 'approval', {
            data,
            authority,
            approverVersion,
            requestHash,
            commandId: input.commandId,
          });
          await tx.insert(financialImportApprovals).values({
            id: data.id,
            operationId: scope.operationId,
            commandId: input.commandId,
            requestHash,
            planHash: input.planHash,
            data,
            authority,
            approverVersion,
            proofHash,
            createdAt: data.issuedAt,
          });
          return data;
        }),
      );
    },
    async read(
      scope: ImportFinancialScope,
      planHash: string,
    ): Promise<FinancialImportApprovalView | null> {
      financialImportScopeSchema.parse(scope);
      return db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(financialImportApprovals)
          .where(
            and(
              eq(financialImportApprovals.operationId, scope.operationId),
              eq(financialImportApprovals.planHash, planHash),
            ),
          )
          .orderBy(desc(financialImportApprovals.createdAt), desc(financialImportApprovals.id))
          .limit(1);
        if (!row) return null;
        const data = verifyFinancialApprovalRow(row, options.secret);
        if (
          data.actorId !== scope.actorId ||
          data.storeId !== scope.storeId ||
          data.counterId !== scope.counterId
        )
          throw importFinancialError('ORDER_IMPORT_APPROVAL_CONFLICT');
        let valid = data.expiresAt > now();
        try {
          await assertFinancialImportAuthority(tx, scope, row.authority);
          await assertCurrentInventoryAccess(tx, data.approverId, scope.storeId);
          const close = await currentImportClose(tx, scope, data.businessDate);
          valid =
            valid &&
            JSON.stringify(close) === JSON.stringify(data.close) &&
            row.approverVersion === (await contactActorVersion(tx, data.approverId));
        } catch {
          valid = false;
        }
        return { ...data, status: valid ? 'approved' : 'stale' };
      });
    },
    async authorizeStart(
      tx: AdministrationTransaction,
      input: ImportFinancialScope & { plan: LegacyOrderImportPlan; planHash: string },
    ) {
      const { plan, planHash, ...scope } = input;
      validate(scope, plan, planHash);
      const authority = await captureFinancialImportAuthority(tx, config, scope, plan, now());
      if (!importNeedsPeriodApproval(config, plan, authority, now()))
        return { ready: true as const, authority };
      const approval = await currentFinancialImportApproval(
        tx,
        options.secret,
        scope,
        planHash,
        authority,
        now(),
      );
      return approval
        ? { ready: true as const, authority: { ...authority, approvalId: approval.id } }
        : { ready: false as const, code: 'ORDER_IMPORT_APPROVAL_REQUIRED' as const };
    },
  };
}
