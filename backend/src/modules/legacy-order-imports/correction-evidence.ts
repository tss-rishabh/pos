import type { importCorrections } from './correction-schema.js';
import {
  importCorrectionBindingSchema,
  importCorrectionReceiptSchema,
} from './correction-contracts.js';
import { equalImportHash, financialImportHash } from './financial-adapter-crypto.js';
import { correctionError } from './correction-domain.js';

export type ImportCorrectionRow = typeof importCorrections.$inferSelect;
export function importCorrectionRecordProof(
  row: Omit<ImportCorrectionRow, 'proofHash'>,
  secret: string,
) {
  return financialImportHash(secret, 'manager-correction-record', row);
}
export function verifiedImportCorrectionRecord(row: ImportCorrectionRow, secret: string) {
  const body = importCorrectionBindingSchema.parse(row.body),
    receipt = importCorrectionReceiptSchema.parse(row.receipt),
    { proofHash, ...fields } = row,
    original = body.original,
    target = body.successor;
  if (
    !equalImportHash(proofHash, importCorrectionRecordProof(fields, secret)) ||
    body.id !== row.id ||
    receipt.id !== row.id ||
    original.jobId !== row.originalJobId ||
    original.operationId !== row.originalOperationId ||
    target.jobId !== row.successorJobId ||
    target.operationId !== row.successorOperationId ||
    body.manager.id !== row.managerId ||
    body.manager.id !== original.actorId ||
    body.manager.id !== target.actorId ||
    original.boundary.scope.actorId !== original.actorId ||
    original.boundary.scope.operationId !== original.operationId ||
    original.boundary.scope.storeId !== target.storeId ||
    original.boundary.scope.counterId !== target.counterId ||
    original.boundary.planHash !== original.planHash ||
    (body.previousCorrectionId === null &&
      (body.depth !== 1 ||
        body.root.jobId !== original.jobId ||
        body.root.operationId !== original.operationId ||
        body.root.uploadHash !== original.uploadHash)) ||
    (body.previousCorrectionId !== null && body.depth < 2) ||
    new Set([original.jobId, original.operationId, body.id, target.jobId, target.operationId])
      .size !== 5 ||
    receipt.originalJobId !== row.originalJobId ||
    receipt.originalOperationId !== row.originalOperationId ||
    receipt.successorJobId !== row.successorJobId ||
    receipt.successorOperationId !== row.successorOperationId ||
    receipt.managerId !== row.managerId ||
    receipt.recordedAt !== row.createdAt ||
    body.manager.attestedAt !== row.createdAt ||
    receipt.historicalTenderAmount !== body.historicalTenderAmount
  )
    throw correctionError('ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID');
  return { body, receipt };
}
/** Pure verifier for the financial core; returns no browser-trusted data. */
export function verifyImportCorrectionRow(row: ImportCorrectionRow, secret: string) {
  return verifiedImportCorrectionRecord(row, secret).body;
}
