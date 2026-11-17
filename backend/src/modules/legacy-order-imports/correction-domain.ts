import { AppError } from '../../domain/errors.js';
import { financialImportHash, expectedFinancialPlanHash } from './financial-adapter-crypto.js';
import { offlineOrderImportPlan, type LegacyOrderImportPlan } from './plans.js';
import type { LegacyImportGroup } from './csv.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import {
  importCorrectionBindingSchema,
  importCorrectionInputSchema,
  type ImportCorrectionBinding,
  type ImportCorrectionInput,
} from './correction-contracts.js';

export const correctionError = (code: string, status = 409) =>
  new AppError(
    status,
    code,
    'The original import needs manager review. Recover its original reference before creating a successor.',
  );

export function correctedImportPlanHash(
  secret: string,
  scope: ImportFinancialScope,
  plan: LegacyOrderImportPlan,
  binding: ImportCorrectionBinding,
) {
  importCorrectionBindingSchema.parse(binding);
  return expectedFinancialPlanHash(secret, scope, plan, binding);
}
export function correctedOrderedRowsHash(secret: string, rows: LegacyImportGroup['lines']) {
  return financialImportHash(secret, 'correction-ordered-rows', rows);
}
export function applyImportCorrection(group: LegacyImportGroup, value: ImportCorrectionInput) {
  const input = importCorrectionInputSchema.parse(value),
    changes = new Map(input.lines.map((line) => [line.row, line.unitPrice]));
  if (changes.size !== group.lines.length || group.lines.some((line) => !changes.has(line.row)))
    throw correctionError('ORDER_IMPORT_CORRECTION_ROWS_CHANGED');
  // Product, quantity, ordered row identity, customer, date, store, payment,
  // original reference and SMS/message instructions remain those of the upload.
  const corrected: LegacyImportGroup = {
      ...group,
      sequence: 1,
      details: { ...group.details },
      address: group.address ? { ...group.address } : null,
      lines: group.lines.map((line) => ({ ...line, price: changes.get(line.row)! })),
    },
    plan = offlineOrderImportPlan(corrected);
  return { group: corrected, plan };
}
