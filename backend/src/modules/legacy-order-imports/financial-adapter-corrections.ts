import { and, eq, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
import {
  importCorrectionBindingSchema,
  importCorrectionContract,
  type ImportCorrectionBinding,
} from './correction-contracts.js';
import { importCorrections } from './correction-schema.js';
import { verifyImportCorrectionRow } from './correction-evidence.js';
import { readFinancialImportRecord } from './financial-adapter-record.js';
import { financialImportCorrectionBoundary } from './financial-adapter-correction-boundary.js';
import type {
  FinancialImportAuthority,
  ImportCompletedProof,
} from './financial-adapter-contracts.js';
import {
  equalImportHash,
  financialImportHash,
  importFinancialError,
} from './financial-adapter-crypto.js';

export interface FinancialCorrectionOptions {
  secret: string;
  sourceProofKey?: string;
  correctionContract?: typeof importCorrectionContract;
  clock?: () => number;
}

/** Read-only identity checks also apply to retained completions after writes are disabled. */
export function assertCorrectionPlanIdentity(
  scope: ImportFinancialScope,
  plan: LegacyOrderImportPlan,
  value: ImportCorrectionBinding,
) {
  const binding = importCorrectionBindingSchema.parse(value),
    target = binding.successor,
    boundary = binding.original.boundary,
    calculation = boundary.calculation;
  if (
    plan.kind !== 'offline' ||
    target.actorId !== scope.actorId ||
    target.operationId !== scope.operationId ||
    target.storeId !== scope.storeId ||
    target.counterId !== scope.counterId ||
    binding.manager.id !== scope.actorId ||
    binding.original.actorId !== scope.actorId ||
    boundary.scope.actorId !== scope.actorId ||
    boundary.scope.storeId !== scope.storeId ||
    boundary.scope.counterId !== scope.counterId ||
    boundary.scope.operationId !== binding.original.operationId ||
    binding.original.operationId === scope.operationId ||
    binding.businessDateTime !== plan.createdAt ||
    binding.payment !== plan.payment ||
    !calculation?.profileQualified ||
    calculation.profileCode !== null ||
    binding.historicalTenderAmount !== calculation.payable
  )
    throw importFinancialError('ORDER_IMPORT_CORRECTION_SCOPE_INVALID');
  return binding;
}

/** Completed evidence remains valid after legitimate later logins, benefits or contract changes. */
export function assertCompletedImportCorrection(proof: ImportCompletedProof) {
  const binding = proof.correction;
  if (!binding) return;
  const target = binding.successor,
    amount = binding.historicalTenderAmount;
  if (
    proof.kind !== 'offline' ||
    target.actorId !== proof.scope.actorId ||
    target.operationId !== proof.scope.operationId ||
    target.storeId !== proof.scope.storeId ||
    target.counterId !== proof.scope.counterId ||
    binding.manager.id !== proof.scope.actorId ||
    binding.original.actorId !== proof.scope.actorId ||
    binding.original.boundary.customerId !== proof.authority.customerId ||
    binding.businessDateTime !== proof.order.createdAt ||
    proof.order.payable !== amount ||
    !binding.original.boundary.calculation?.profileQualified ||
    binding.original.boundary.calculation.payable !== amount ||
    (binding.payment === 'cash'
      ? proof.settlement.cash !== amount ||
        proof.settlement.cashReceived !== amount ||
        proof.settlement.manualOther !== '0.00'
      : proof.settlement.cash !== '0.00' ||
        proof.settlement.cashReceived !== '0.00' ||
        proof.settlement.manualOther !== amount)
  )
    throw importFinancialError('ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID');
}

/** Every new approval/dispatch consumes an immutable server record, never a browser descriptor. */
export async function assertFinancialImportCorrection(
  tx: AdministrationTransaction,
  input: {
    scope: ImportFinancialScope;
    plan: LegacyOrderImportPlan;
    planHash: string;
    correction?: ImportCorrectionBinding;
  },
  options: FinancialCorrectionOptions,
  authority: FinancialImportAuthority,
) {
  if (!input.correction) return;
  if (options.correctionContract !== importCorrectionContract)
    throw importFinancialError('ORDER_IMPORT_CORRECTION_DISABLED', 503);
  const binding = assertCorrectionPlanIdentity(input.scope, input.plan, input.correction);
  const [row] = await tx
    .select()
    .from(importCorrections)
    .where(
      and(
        eq(importCorrections.id, binding.id),
        sql`OCTET_LENGTH(${importCorrections.body})<=16000`,
        sql`OCTET_LENGTH(${importCorrections.receipt})<=4000`,
      ),
    )
    .limit(1)
    .for('share');
  if (!row) throw importFinancialError('ORDER_IMPORT_CORRECTION_EVIDENCE_REQUIRED');
  const retained = verifyImportCorrectionRow(row, options.secret);
  if (
    row.planHash !== input.planHash ||
    row.createdAt > (options.clock ?? Date.now)() ||
    !equalImportHash(
      financialImportHash(options.secret, 'correction-binding', retained),
      financialImportHash(options.secret, 'correction-binding', binding),
    )
  )
    throw importFinancialError('ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID');
  const parent = await readFinancialImportRecord(
    tx,
    binding.original.boundary.scope,
    options.secret,
  );
  if (
    !parent ||
    parent.state.planHash !== binding.original.planHash ||
    parent.plan.kind !== 'offline' ||
    binding.previousCorrectionId !== (parent.state.correction?.id ?? null) ||
    binding.depth !== (parent.state.correction?.depth ?? 0) + 1 ||
    (parent.state.correction &&
      !equalImportHash(
        financialImportHash(options.secret, 'correction-root', binding.root),
        financialImportHash(options.secret, 'correction-root', parent.state.correction.root),
      )) ||
    // The approved active path changes the attested tender, never historical products/prices/customer.
    !equalImportHash(
      financialImportHash(options.secret, 'correction-price-plan', input.plan),
      financialImportHash(options.secret, 'correction-price-plan', {
        ...parent.plan,
        sequence: input.plan.sequence,
      }),
    ) ||
    authority.customerId !== binding.original.boundary.customerId
  )
    throw importFinancialError('ORDER_IMPORT_CORRECTION_SCOPE_INVALID');
  const actual = await financialImportCorrectionBoundary({
    secret: options.secret,
    sourceProofKey: options.sourceProofKey ?? '',
  }).inspectRejectedBoundary(tx, {
    scope: binding.original.boundary.scope,
    plan: parent.plan,
    planHash: parent.state.planHash,
    ...(parent.state.correction ? { correction: parent.state.correction } : {}),
  });
  if (
    !equalImportHash(
      financialImportHash(options.secret, 'correction-original-boundary', actual),
      financialImportHash(
        options.secret,
        'correction-original-boundary',
        binding.original.boundary,
      ),
    )
  )
    throw importFinancialError('ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED');
}
