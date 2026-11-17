import { and, eq, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import { financialImportOperations } from './financial-adapter-schema.js';
import {
  importFinancialStateSchema,
  financialImportScopeSchema,
} from './financial-adapter-contracts.js';
import {
  equalImportHash,
  financialImportRequestHash,
  importFinancialError,
  openFinancialPlan,
} from './financial-adapter-crypto.js';

/** Current, bounded, authenticated private journal document; caller owns transaction scope. */
export async function readFinancialImportRecord(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
  secret: string,
) {
  const bound = financialImportScopeSchema.parse({
    actorId: scope.actorId,
    operationId: scope.operationId,
    storeId: scope.storeId,
    counterId: scope.counterId,
  });
  const [row] = await tx
    .select()
    .from(financialImportOperations)
    .where(
      and(
        eq(financialImportOperations.id, bound.operationId),
        sql`OCTET_LENGTH(${financialImportOperations.state})<=16000`,
        sql`OCTET_LENGTH(${financialImportOperations.payload})<=342000`,
      ),
    )
    .limit(1)
    .for('update');
  if (!row) return null;
  const state = importFinancialStateSchema.parse(row.state);
  if (
    row.actorId !== bound.actorId ||
    row.storeId !== bound.storeId ||
    row.counterId !== bound.counterId ||
    JSON.stringify(state.scope) !== JSON.stringify(bound) ||
    state.planHash !== row.planHash ||
    state.requestHash !== row.requestHash ||
    state.namespace !== row.namespace
  )
    throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
  const plan = openFinancialPlan(secret, bound, row.planHash, row.payload);
  if (
    !equalImportHash(
      state.requestHash,
      financialImportRequestHash(secret, {
        scope: bound,
        planHash: state.planHash,
        plan,
        authority: state.authority,
        ...(state.correction ? { correction: state.correction } : {}),
      }),
    )
  )
    throw importFinancialError('ORDER_IMPORT_FINANCIAL_PAYLOAD_INVALID');
  return { state, plan };
}
