import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';

export const inventoryPullInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('manual'), skus: z.string().max(4096) }).strict(),
  z
    .object({
      mode: z.literal('csv'),
      filename: z
        .string()
        .min(1)
        .max(255)
        .refine((value) => value.toLowerCase().endsWith('.csv')),
      csv: z.string().max(512000),
    })
    .strict(),
]);
export type InventoryPullInput = z.infer<typeof inventoryPullInput>;
function sku(value: string, row?: number) {
  const trimmed = value.trim();
  if (!/^\+?\d+$/.test(trimmed))
    throw new AppError(
      400,
      'INVALID_INVENTORY_SKU',
      row
        ? `Use a valid SKU ID on CSV row ${row}.`
        : 'Use positive numeric SKU IDs separated by commas.',
    );
  const normalized = String(BigInt(trimmed));
  if (!identifier.safeParse(normalized).success)
    throw new AppError(400, 'INVALID_INVENTORY_SKU', 'A SKU ID is outside the supported range.');
  return normalized;
}
export function inventoryPullSelection(value: InventoryPullInput) {
  const input = inventoryPullInput.parse(value);
  let rows: string[];
  if (input.mode === 'manual') {
    const text = input.skus.replaceAll(' ', '').replace(/,+$/, '');
    rows = text ? text.split(',') : [];
    if (!rows.length)
      throw new AppError(400, 'INVENTORY_SKUS_REQUIRED', 'Enter at least one SKU ID.');
    if (rows.length > 40)
      throw new AppError(400, 'INVENTORY_MANUAL_LIMIT', 'Enter at most 40 SKU IDs.');
    rows = rows.map((value) => sku(value));
  } else {
    if (Buffer.byteLength(input.csv, 'utf8') > 512000)
      throw new AppError(413, 'INVENTORY_CSV_TOO_LARGE', 'Use a CSV file no larger than 500 KB.');
    let records: unknown;
    try {
      records = parse(input.csv, {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        max_record_size: 4096,
        relax_column_count: false,
      });
    } catch {
      throw new AppError(400, 'INVALID_INVENTORY_CSV', 'Use a valid UTF-8 CSV with a sku header.');
    }
    const parsed = z
      .array(z.object({ sku: z.string() }))
      .max(10000)
      .safeParse(records);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_INVENTORY_CSV',
        'Use a sku header and at most 10,000 SKU rows.',
      );
    if (!parsed.data.length)
      throw new AppError(400, 'INVENTORY_SKUS_REQUIRED', 'Add at least one SKU row to the CSV.');
    rows = parsed.data.map((row, index) => sku(row.sku, index + 2));
  }
  const ids = [...new Set(rows)].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
  );
  return { mode: input.mode, ids, requestedCount: rows.length, uniqueRequestedCount: ids.length };
}
export const maintenancePayload = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inventory-pull'),
      mode: z.enum(['manual', 'csv']),
      productIds: z.array(identifier).min(1).max(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('product-sync'),
      productIds: z.array(identifier).min(1).max(1000),
      troubleshoot: z.boolean(),
    })
    .strict(),
]);
export type MaintenancePayload = z.infer<typeof maintenancePayload>;
/** Numeric JSON tokens match Python int serialization without unsafe JavaScript Number conversion. */
export function inventoryPullBody(value: MaintenancePayload) {
  const input = maintenancePayload.parse(value);
  if (input.kind !== 'inventory-pull')
    throw new AppError(
      500,
      'INVALID_INVENTORY_DELIVERY',
      'Inventory delivery has an invalid type.',
    );
  return `{"productIds":[${input.productIds.join(',')}]${input.mode === 'manual' ? ',"priority":1' : ''}}`;
}
export function temporarySourceBarcode(value: string) {
  if (!/^[1-9]\d*$/.test(value))
    throw new AppError(
      422,
      'CATALOG_BARCODE_RECONCILIATION_REQUIRED',
      'Reconcile the product barcode before troubleshooting.',
    );
  const candidate = BigInt(value + '0123');
  if (candidate > 9223372036854775807n)
    throw new AppError(
      422,
      'CATALOG_BARCODE_RECONCILIATION_REQUIRED',
      'The temporary barcode exceeds the source column range. Reconcile its duplicates manually.',
    );
  return String(candidate);
}
