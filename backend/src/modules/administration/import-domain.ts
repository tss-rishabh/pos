import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import type { inventoryImports, StockImportCells, StockImportCommand } from './import-schema.js';

export const stockImportHeaders = [
  'SkuId',
  'StoreId',
  'IsHold',
  'Hold/UnholdQty',
  'IsAvailable',
  'IsDelete',
] as const;
export const maximumImportBytes = 256 * 1024;
export const maximumImportRows = 5000;
export const inventoryCsvInput = z
  .object({
    id: z.uuid(),
    name: z
      .string()
      .min(5)
      .max(120)
      .regex(/^[^\p{C}\\/]+\.csv$/iu),
    csv: z
      .string()
      .min(1)
      .max(maximumImportBytes)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumImportBytes),
  })
  .strict();
export const stockImportInput = inventoryCsvInput;
export type InventoryCsvInput = z.infer<typeof inventoryCsvInput>;
export type StockImportInput = InventoryCsvInput;
export const importHistoryInput = z
  .object({
    after: z.union([z.literal('0'), identifier]).default('0'),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .strict();
export function importJobDto(job: Omit<typeof inventoryImports.$inferSelect, 'profile'>) {
  return {
    id: job.id,
    actorId: job.actorId,
    name: job.name,
    state: job.state,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    successfulRows: job.successfulRows,
    failedRows: job.failedRows,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
export const importIdInput = z.object({ importId: z.uuid() }).strict();
export const importListInput = z
  .object({
    after: z.union([z.literal('0'), identifier]).default('0'),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const importRowListInput = z
  .object({
    after: z.coerce
      .number()
      .int()
      .min(0)
      .max(maximumImportRows + 1)
      .default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    state: z.enum(['all', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']).default('all'),
  })
  .strict();
export const stockImportCells = z.tuple([
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
]);
export const stockImportCommand = z
  .object({
    productId: identifier,
    storeId: identifier,
    movement: z.enum(['hold', 'unhold', 'none']),
    quantity: z.number().int().min(0).max(2_147_483_647),
    available: z.boolean().nullable(),
    archived: z.boolean().nullable(),
  })
  .strict()
  .refine((row) => (row.movement === 'none' ? row.quantity === 0 : row.quantity > 0));
export interface ParsedImportRow {
  rowNumber: number;
  cells: StockImportCells;
  command: StockImportCommand | null;
  errorCode: string | null;
  message: string | null;
}
const positiveInteger = (value: string): string => {
  const normalized = value.trim();
  if (!/^\+?\d(?:_?\d)*$/.test(normalized)) throw new Error('Invalid decimal');
  return identifier.parse(BigInt(normalized.replace(/_/g, '')).toString());
};
function booleanCell(value: string): boolean | null {
  if (!value.trim()) return null;
  if (!['0', '1'].includes(value.trim())) throw new Error('Invalid flag');
  return value.trim() === '1';
}
export function parseStockImport(csv: string): ParsedImportRow[] {
  if (Buffer.byteLength(csv, 'utf8') > maximumImportBytes)
    throw new AppError(400, 'INVENTORY_CSV_TOO_LARGE', 'Choose a CSV file up to 256 KiB.');
  let matrix: string[][];
  try {
    matrix = parse(csv, {
      columns: false,
      bom: true,
      cast: false,
      skip_empty_lines: true,
      max_record_size: 4096,
      to: maximumImportRows + 2,
    });
  } catch {
    throw new AppError(
      400,
      'INVENTORY_CSV_INVALID',
      'Use a valid UTF-8 CSV with consistent columns.',
    );
  }
  const headers = matrix.shift();
  if (
    !headers ||
    headers.length !== stockImportHeaders.length ||
    new Set(headers).size !== headers.length ||
    stockImportHeaders.some((name) => !headers.includes(name))
  )
    throw new AppError(
      400,
      'INVENTORY_CSV_HEADERS_INVALID',
      'Use the exact stock-import template columns.',
    );
  if (!matrix.length || matrix.length > maximumImportRows)
    throw new AppError(400, 'INVENTORY_CSV_ROW_LIMIT', 'Choose between one and 5000 CSV records.');
  return matrix.map((record, index) => {
    const fields = stockImportCells.safeParse(
      stockImportHeaders.map((name) => record[headers.indexOf(name)]),
    );
    if (!fields.success)
      throw new AppError(
        400,
        'INVENTORY_CSV_CELL_LIMIT',
        'Keep each CSV field within 128 characters.',
      );
    const cells = fields.data;
    try {
      const isHold = booleanCell(cells[2]),
        quantity = cells[3].trim();
      if ((isHold === null) !== (quantity === '')) throw new Error('Incomplete movement');
      const parsedQuantity = quantity ? BigInt(positiveInteger(quantity)) : 0n;
      if (parsedQuantity > 2_147_483_647n) throw new Error('Quantity range');
      const command = stockImportCommand.parse({
        productId: positiveInteger(cells[0]),
        storeId: positiveInteger(cells[1]),
        movement: isHold === null ? 'none' : isHold ? 'hold' : 'unhold',
        quantity: Number(parsedQuantity),
        available: booleanCell(cells[4]),
        archived: booleanCell(cells[5]),
      });
      return { rowNumber: index + 2, cells, command, errorCode: null, message: null };
    } catch {
      return {
        rowNumber: index + 2,
        cells,
        command: null,
        errorCode: 'INVENTORY_CSV_ROW_INVALID',
        message: 'Error while traversing csv data.',
      };
    }
  });
}
export function stockImportChecksum(csv: string): string {
  return createHash('sha256').update(csv).digest('hex');
}
export function stockCsv(rows: readonly (readonly string[])[], spreadsheetSafe = false): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            const cell =
              spreadsheetSafe && /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) ? `'${value}` : value;
            return `"${cell.replace(/"/g, '""')}"`;
          })
          .join(','),
      )
      .join('\r\n') + '\r\n'
  );
}
export const stockTemplateRows = [
  [...stockImportHeaders],
  [
    'Enter parent product ids only for simple products and for configurable only variant SKU ID will be used.)',
    'For store ids please refer instructions on the store bulk upload page',
    '1=>For Hold | 0=> For Unhold',
    'Hold/Unhold Quantity',
    '0=>Product listing off | 1=>Product listing on',
    '0=>Activate Product | 1=>Deactivate Product',
  ],
  ['1234', '1', '1', '8', '1', '0'],
] as const;
