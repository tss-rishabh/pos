import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  financialImportScopeSchema,
  type ImportFinancialState,
} from './financial-adapter-contracts.js';
import {
  equalImportHash,
  financialImportHash,
  importFinancialError,
} from './financial-adapter-crypto.js';
import {
  financialImportStages,
  financialImportOrderBindings,
  financialImportSourceReceipts,
  financialImportSourceEffects,
  financialImportProofs,
  financialImportCloseImpacts,
} from './financial-adapter-schema.js';

const admissionCode = z.enum([
  'ORDER_IMPORT_SCREENING_LIMIT',
  'ORDER_IMPORT_SCREENING_CATALOG_REVIEW',
]);
export type FinancialAdmissionCode = z.infer<typeof admissionCode>;
/** Only native business refusals from admission-only code may be classified. */
export class FinancialImportAdmissionDenied extends AppError {
  declare readonly code: FinancialAdmissionCode;
  constructor(code: FinancialAdmissionCode) {
    super(
      409,
      admissionCode.parse(code),
      'This import was refused before any order or payment dispatch.',
    );
  }
}
export const nativeAdmissionRejectionSchema = z
  .object({
    contract: z.literal('pos-import-native-admission-v1'),
    scope: financialImportScopeSchema,
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    namespace: z.string().max(64),
    code: admissionCode,
    noFinancialEffects: z.literal(true),
    nonce: z.uuid(),
  })
  .strict()
  .refine(
    (value) => value.namespace === 'pos-import-v1:' + value.scope.operationId,
    'Invalid admission namespace.',
  );
export type NativeAdmissionRejection = z.infer<typeof nativeAdmissionRejectionSchema>;
const invalid = () => importFinancialError('ORDER_IMPORT_ADMISSION_PROOF_INVALID');

async function stagesFor(tx: AdministrationTransaction, operationId: string) {
  return tx
    .select()
    .from(financialImportStages)
    .where(eq(financialImportStages.operationId, operationId))
    .limit(7)
    .for('share');
}
async function evidence(
  tx: AdministrationTransaction,
  operationId: string,
  stages?: Awaited<ReturnType<typeof stagesFor>>,
) {
  // Every row for this operation is checked; a changed kind/status cannot hide
  // a later checkpoint behind a filtered preparation lookup.
  stages ??= await stagesFor(tx, operationId);
  const bindings = await tx
    .select({ id: financialImportOrderBindings.orderId })
    .from(financialImportOrderBindings)
    .where(eq(financialImportOrderBindings.operationId, operationId))
    .limit(1)
    .for('share');
  const receipts = await tx
    .select({ id: financialImportSourceReceipts.id })
    .from(financialImportSourceReceipts)
    .where(eq(financialImportSourceReceipts.operationId, operationId))
    .limit(1)
    .for('share');
  const effects = await tx
    .select({ id: financialImportSourceEffects.operationId })
    .from(financialImportSourceEffects)
    .where(eq(financialImportSourceEffects.operationId, operationId))
    .limit(1)
    .for('share');
  const proofs = await tx
    .select({ id: financialImportProofs.id })
    .from(financialImportProofs)
    .where(eq(financialImportProofs.operationId, operationId))
    .limit(1)
    .for('share');
  const closes = await tx
    .select({ id: financialImportCloseImpacts.id })
    .from(financialImportCloseImpacts)
    .where(eq(financialImportCloseImpacts.operationId, operationId))
    .limit(1)
    .for('share');
  return {
    stages,
    hasEffects:
      bindings.length + receipts.length + effects.length + proofs.length + closes.length > 0,
  };
}
function stageRequest(secret: string, proof: NativeAdmissionRejection) {
  return financialImportHash(secret, 'stage', {
    scope: proof.scope,
    kind: 'preparation',
    requestHash: proof.requestHash,
    nonce: proof.nonce,
  });
}
export async function recordNativeAdmissionRejection(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  code: FinancialAdmissionCode,
  secret: string,
  now: number,
): Promise<NativeAdmissionRejection> {
  const found = await evidence(tx, state.scope.operationId);
  if (
    state.status !== 'running' ||
    state.stage !== 'preparation' ||
    state.orderId !== null ||
    found.stages.length ||
    found.hasEffects
  )
    throw invalid();
  const proof = nativeAdmissionRejectionSchema.parse({
    contract: 'pos-import-native-admission-v1',
    scope: state.scope,
    planHash: state.planHash,
    requestHash: state.requestHash,
    namespace: state.namespace,
    code,
    noFinancialEffects: true,
    nonce: randomUUID(),
  });
  await tx.insert(financialImportStages).values({
    id: state.scope.operationId + ':preparation',
    operationId: state.scope.operationId,
    kind: 'preparation',
    nonce: proof.nonce,
    status: 'rejected',
    requestHash: stageRequest(secret, proof),
    proofHash: financialImportHash(secret, 'native-admission-rejection', proof),
    proof,
    createdAt: now,
    updatedAt: now,
  });
  return proof;
}
export async function verifiedNativeAdmissionRejection(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  secret: string,
): Promise<NativeAdmissionRejection | null> {
  const stages = await stagesFor(tx, state.scope.operationId),
    row = stages.find(
      (value) =>
        value.kind === 'preparation' || value.id === state.scope.operationId + ':preparation',
    );
  if (!row) {
    if (state.status === 'rejected' && state.stage === 'preparation') throw invalid();
    return null;
  }
  const found = await evidence(tx, state.scope.operationId, stages);
  const parsed = nativeAdmissionRejectionSchema.safeParse(row.proof);
  if (!parsed.success) throw invalid();
  const proof = parsed.data;
  if (
    found.stages.length !== 1 ||
    found.hasEffects ||
    state.status !== 'rejected' ||
    state.stage !== 'preparation' ||
    state.orderId !== null ||
    state.errorCode !== proof.code ||
    JSON.stringify(proof.scope) !== JSON.stringify(state.scope) ||
    proof.planHash !== state.planHash ||
    proof.requestHash !== state.requestHash ||
    proof.namespace !== state.namespace ||
    row.id !== state.scope.operationId + ':preparation' ||
    row.kind !== 'preparation' ||
    row.status !== 'rejected' ||
    row.operationId !== state.scope.operationId ||
    row.nonce !== proof.nonce ||
    !equalImportHash(row.requestHash, stageRequest(secret, proof)) ||
    !row.proofHash ||
    !equalImportHash(
      row.proofHash,
      financialImportHash(secret, 'native-admission-rejection', proof),
    )
  )
    throw invalid();
  return proof;
}
