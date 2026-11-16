import { AppError } from '../../domain/errors.js';
export type WorkbookConflictField = 'variant' | 'GTIN' | 'category';
export class InventoryWorkbookAmbiguityError extends AppError {
  constructor(
    readonly productId: string,
    readonly field: WorkbookConflictField,
  ) {
    super(
      409,
      'INVENTORY_WORKBOOK_AMBIGUOUS',
      `Product ${productId} has multiple source ${field} values. Reconcile its inventory associations before exporting.`,
    );
  }
}
export function workbookFailureCode(error: unknown): string | undefined {
  return error instanceof InventoryWorkbookAmbiguityError
    ? `WORKBOOK_${error.field.toUpperCase()}_AMBIGUOUS:${error.productId}`
    : undefined;
}
/** Persist only static field names and opaque SKU IDs, never the conflicting raw text. */
export function workbookFailureMessage(code: string | null): string | undefined {
  const matched = /^WORKBOOK_(VARIANT|GTIN|CATEGORY)_AMBIGUOUS:([1-9]\d{0,18})$/.exec(code ?? '');
  return matched
    ? `Product ${matched[2]} has conflicting ${matched[1]!.toLowerCase()} values. Reconcile its source associations before requesting another workbook.`
    : undefined;
}
