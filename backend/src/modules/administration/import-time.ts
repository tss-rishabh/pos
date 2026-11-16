import { Temporal } from '@js-temporal/polyfill';
import { utcMediaTimestamp } from './media-domain.js';
import type { inventoryImports } from './import-schema.js';

type ImportAge = Pick<typeof inventoryImports.$inferSelect, 'createdAt' | 'state'>;
/** Rewrite import dates are UTC wall DATETIME(3); retain the exact elapsed24h decision. */
export function historicalInventoryImport(row: ImportAge, cutoff: Temporal.Instant) {
  return (
    ['COMPLETED', 'CANCELLED'].includes(row.state) &&
    Temporal.Instant.compare(Temporal.Instant.from(row.createdAt.replace(' ', 'T') + 'Z'), cutoff) <
      0
  );
}
/** For a strict `<` bound, ceiling preserves membership at the destination's precision. */
export function warehouseImportCutoff(cutoff: Temporal.Instant) {
  return cutoff.round({ smallestUnit: 'microsecond', roundingMode: 'ceil' }).toString();
}
/** The complementary operational `>=` predicate compares stored millisecond values. */
export function mysqlImportCutoff(cutoff: Temporal.Instant) {
  return utcMediaTimestamp(cutoff.round({ smallestUnit: 'millisecond', roundingMode: 'ceil' }));
}
