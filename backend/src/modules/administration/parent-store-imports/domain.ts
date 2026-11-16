import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { inventoryCsvInput, maximumImportBytes, maximumImportRows } from '../import-domain.js';
import type { QueueImportRow } from '../import-profile.js';
export const parentStoreHeaders = ['SkuId', 'StoreId', 'IsActive'] as const;
export const parentStoreInput = inventoryCsvInput;
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const parentStoreCommand = z
  .object({ kind: z.literal('parent-store'), productId: id, storeId: id, active: z.boolean() })
  .strict();
export const parentStoreCells = z.tuple([
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
]);
function integer(value: string) {
  const text = value.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(text)) throw new Error('Invalid integer');
  return BigInt(text.replaceAll('_', ''));
}
export function parseParentStoreImport(csv: string): QueueImportRow[] {
  if (Buffer.byteLength(csv, 'utf8') > maximumImportBytes)
    throw new AppError(400, 'PARENT_STORE_CSV_TOO_LARGE', 'Choose a CSV file up to 256 KiB.');
  let matrix: string[][];
  try {
    matrix = parse(csv, {
      columns: false,
      record_delimiter: ['\r\n', '\n', '\r'],
      bom: true,
      cast: false,
      skip_empty_lines: true,
      max_record_size: 4096,
      to: maximumImportRows + 2,
    });
  } catch {
    throw new AppError(
      400,
      'PARENT_STORE_CSV_INVALID',
      'Use a valid UTF-8 CSV with consistent columns.',
    );
  }
  const headers = matrix.shift();
  if (
    !headers ||
    headers.length !== 3 ||
    new Set(headers).size !== 3 ||
    parentStoreHeaders.some((name) => !headers.includes(name))
  )
    throw new AppError(
      400,
      'PARENT_STORE_CSV_HEADERS_INVALID',
      'Use exactly SkuId, StoreId and IsActive.',
    );
  if (!matrix.length || matrix.length > maximumImportRows)
    throw new AppError(
      400,
      'PARENT_STORE_CSV_ROW_LIMIT',
      'Choose between one and 5000 CSV records.',
    );
  const rows: QueueImportRow[] = matrix.map((record, index) => {
    const parsed = parentStoreCells.safeParse(
      parentStoreHeaders.map((name) => record[headers.indexOf(name)]),
    );
    if (!parsed.success)
      throw new AppError(
        400,
        'PARENT_STORE_CSV_CELL_LIMIT',
        'Keep each CSV field within 128 characters.',
      );
    const cells = parsed.data,
      base = { rowNumber: index + 2, cells, command: null, errorCode: null, message: null };
    try {
      const product = integer(cells[0]),
        store = integer(cells[1]),
        active = integer(cells[2]);
      if (product === 0n || store === 0n || ![0n, 1n].includes(active))
        return {
          ...base,
          errorCode: 'PARENT_STORE_PARAMETERS_MISSING',
          message: 'Required parameters are missing.',
        };
      return {
        ...base,
        command: parentStoreCommand.parse({
          kind: 'parent-store',
          productId: String(product),
          storeId: String(store),
          active: active === 1n,
        }),
      };
    } catch {
      return {
        ...base,
        errorCode: 'PARENT_STORE_CSV_ROW_INVALID',
        message: 'Error while traversing csv data.',
      };
    }
  });
  const pairs = new Map<string, QueueImportRow[]>();
  for (const row of rows)
    if (row.command) {
      const key = row.command.storeId + ':' + row.command.productId,
        list = pairs.get(key) || [];
      list.push(row);
      pairs.set(key, list);
    }
  for (const list of pairs.values())
    if (list.length > 1)
      for (const row of list) {
        row.command = null;
        row.errorCode = 'PARENT_STORE_DUPLICATE_PAIR';
        row.message = 'Repeated parent/store pairs require separate imports.';
      }
  return rows;
}
export const parentStoreTemplate = [
  parentStoreHeaders,
  [
    'Enter only parent product ids (variants product ids are not allowed)',
    'For store ids please refer instructions on the store bulk upload page',
    '1=>Active and 0=>Delete',
  ],
  ['1234', '1', '1'],
] as const;
