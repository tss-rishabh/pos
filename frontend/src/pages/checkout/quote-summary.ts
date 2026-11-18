import type { Checkout } from './client';

export function calculationAmounts(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || !('meta' in value)) return null;
  const meta = value.meta;
  if (typeof meta !== 'object' || meta === null || !('items' in meta) || !Array.isArray(meta.items))
    return null;
  const rows: unknown[] = meta.items;
  const calculations = rows.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && 'name' in row && row.name === 'calculations',
  );
  return calculations.length === 1 ? calculations[0]! : null;
}
/** Format the supplied decimal lexeme without float conversion, summation, or rounding. */
export function quoteAmount(value: unknown): string | null {
  const decimal =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  if (!/^-?\d+(?:\.\d+)?$/.test(decimal) || decimal.length > 128) return null;
  const [whole = '', fraction = ''] = decimal.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction.padEnd(2, '0');
}
export function quoteIsCurrent(
  checkout: Checkout,
  draft: { id: string; updatedAt: number; ownerId: string; storeId: string; counterId: string },
  available: boolean,
) {
  return (
    available &&
    checkout.operatorId === draft.ownerId &&
    checkout.storeId === draft.storeId &&
    checkout.counterId === draft.counterId &&
    checkout.phase === 'quoted' &&
    checkout.draftId === draft.id &&
    checkout.draftVersion === draft.updatedAt &&
    checkout.draftImport?.status === 'complete' &&
    !checkout.busyOperationId
  );
}
