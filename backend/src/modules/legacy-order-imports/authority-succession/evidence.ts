import { and, eq, sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { assertCheckoutProjection } from '../../checkout/projection.js';
import { paymentAttempts } from '../../checkout/payments/schema.js';
import {
  financialImportStages,
  financialImportSourceReceipts,
  financialImportSourceEffects,
} from '../financial-adapter-schema.js';
import {
  sourceConfirmationReceiptSchema,
  importSettlementReceiptSchema,
  importPublicationReceiptSchema,
  type ImportFinancialState,
} from '../financial-adapter-contracts.js';
import {
  financialImportHash,
  financialSourceHash,
  equalImportHash,
  importFinancialError,
} from '../financial-adapter-crypto.js';
import { readSourceOrderReceipt } from '../financial-adapter-proof.js';
import type { ImportSuccessionStage } from './contracts.js';
/** Positive native receipts repair only acknowledgment metadata. No order,
 * payment, stock, entitlement or task is initiated by this evidence reader. */
export async function successionNativeEvidence(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  keys: { secret: string; sourceProofKey?: string },
) {
  const order = await readSourceOrderReceipt(
    tx,
    state.scope.operationId,
    keys.sourceProofKey ?? '',
  );
  if (
    !order ||
    order.requestHash !== state.requestHash ||
    order.namespace !== state.namespace ||
    order.customerId !== state.authority.customerId ||
    order.storeId !== state.scope.storeId ||
    order.counterId !== state.scope.counterId
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_SOURCE_REQUIRED');
  const [attempt] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, order.orderId))
    .limit(1)
    .for('share');
  if (attempt) throw importFinancialError('ORDER_IMPORT_SUCCESSION_PAYMENT_UNKNOWN');
  const stages = await tx
    .select()
    .from(financialImportStages)
    .where(eq(financialImportStages.operationId, state.scope.operationId))
    .limit(6)
    .for('update');
  if (
    stages.length > 5 ||
    new Set(stages.map((v) => v.kind)).size !== stages.length ||
    !stages.some((v) => v.kind === 'order')
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  for (const stage of stages) {
    if (
      stage.id !== state.scope.operationId + ':' + stage.kind ||
      stage.requestHash !==
        financialImportHash(keys.secret, 'stage', {
          scope: state.scope,
          kind: stage.kind,
          requestHash: state.requestHash,
          nonce: stage.nonce,
        }) ||
      !['dispatched', 'confirmed'].includes(stage.status)
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  }
  const sourceRows = await tx
    .select()
    .from(financialImportSourceReceipts)
    .where(
      and(
        eq(financialImportSourceReceipts.operationId, state.scope.operationId),
        sql`OCTET_LENGTH(${financialImportSourceReceipts.proof})<=1000000`,
      ),
    )
    .limit(13)
    .for('share');
  if (sourceRows.length > 12) throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  const confirmationRow = sourceRows.find((row) => row.kind === 'confirmation'),
    confirmationStage = stages.find((row) => row.kind === 'confirmation');
  let confirmation: ReturnType<typeof sourceConfirmationReceiptSchema.parse> | null = null;
  if (confirmationRow) {
    const value = sourceConfirmationReceiptSchema.parse(confirmationRow.proof);
    if (
      !confirmationStage ||
      confirmationRow.status !== 'completed' ||
      confirmationRow.requestHash !== state.requestHash ||
      value.operationId !== state.scope.operationId ||
      value.requestHash !== state.requestHash ||
      value.nonce !== confirmationStage.nonce ||
      value.orderId !== order.orderId ||
      value.customerId !== order.customerId ||
      value.storeId !== order.storeId ||
      value.counterId !== order.counterId ||
      value.headerHash !== order.headerHash ||
      !equalImportHash(
        confirmationRow.proofHash,
        financialSourceHash(keys.sourceProofKey ?? '', 'confirmation', value),
      )
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
    await assertCheckoutProjection(tx, {
      orderId: order.orderId,
      storeId: order.storeId,
      counterId: order.counterId,
      customerId: order.customerId,
    });
    confirmation = value;
    if (confirmationStage.status === 'dispatched') {
      const proofHash = financialImportHash(keys.secret, 'stage-confirmation', {
        operationId: state.scope.operationId,
        kind: 'confirmation',
        proof: value,
      });
      await tx
        .update(financialImportStages)
        .set({ status: 'confirmed', proof: value, proofHash })
        .where(eq(financialImportStages.id, confirmationStage.id));
      confirmationStage.status = 'confirmed';
      confirmationStage.proof = value;
      confirmationStage.proofHash = proofHash;
    }
  } else if (confirmationStage?.status === 'confirmed')
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
  const settled = stages.find((row) => row.kind === 'settlement');
  let settlement: ReturnType<typeof importSettlementReceiptSchema.parse> | null = null;
  if (settled?.status === 'confirmed') {
    const value = importSettlementReceiptSchema.parse(settled.proof);
    if (
      value.operationId !== state.scope.operationId ||
      value.orderId !== order.orderId ||
      value.kind !== (order.method === 14 ? 'offline' : 'shopify') ||
      !equalImportHash(
        settled.proofHash ?? '',
        financialImportHash(keys.secret, 'stage-confirmation', {
          operationId: state.scope.operationId,
          kind: 'settlement',
          proof: value,
        }),
      )
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
    settlement = value;
  }
  const publicationRow = sourceRows.find((row) => row.kind === 'publication');
  let publication: ReturnType<typeof importPublicationReceiptSchema.parse> | null = null;
  if (publicationRow) {
    const value = importPublicationReceiptSchema.parse(publicationRow.proof);
    if (
      !settlement ||
      publicationRow.status !== 'completed' ||
      value.operationId !== state.scope.operationId ||
      value.requestHash !== state.requestHash ||
      value.orderId !== order.orderId ||
      value.sourceHash !== order.effectsHash ||
      !equalImportHash(
        publicationRow.proofHash,
        financialSourceHash(keys.sourceProofKey ?? '', 'publication', value),
      )
    )
      throw importFinancialError('ORDER_IMPORT_SUCCESSION_PROOF_INVALID');
    publication = value;
  }
  const [effects] = await tx
    .select({
      status: financialImportSourceEffects.status,
      hash: financialImportSourceEffects.effectsHash,
    })
    .from(financialImportSourceEffects)
    .where(eq(financialImportSourceEffects.operationId, state.scope.operationId))
    .limit(1)
    .for('update');
  if (!effects || effects.hash !== order.effectsHash)
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_SOURCE_REQUIRED');
  let code: string | null = null,
    next: ImportSuccessionStage | null = null;
  if (!publication && ['processing', 'uncertain', 'accepted'].includes(effects.status))
    code = 'ORDER_IMPORT_SUCCESSION_PUBLICATION_UNKNOWN';
  else if (!publication && effects.status !== 'pending')
    code = 'ORDER_IMPORT_SUCCESSION_PROOF_INVALID';
  else if (!publication)
    next =
      order.method === 14 && !confirmation
        ? 'confirmation'
        : !settlement
          ? 'settlement'
          : 'publication';
  const evidenceHash = financialImportHash(keys.secret, 'authority-succession-evidence', {
    scope: state.scope,
    requestHash: state.requestHash,
    planHash: state.planHash,
    source: financialSourceHash(keys.sourceProofKey ?? '', 'order', order),
    stages: stages
      .map((row) => ({
        kind: row.kind,
        nonce: row.nonce,
        status: row.status,
        requestHash: row.requestHash,
        proofHash: row.proofHash,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    effects,
    confirmation: confirmationRow?.proofHash ?? null,
    publication: publicationRow?.proofHash ?? null,
  });
  return {
    order,
    confirmation,
    settlement,
    publication,
    next,
    code,
    evidenceHash,
    sourceReceiptHash: financialSourceHash(keys.sourceProofKey ?? '', 'order', order),
    stages,
  };
}
