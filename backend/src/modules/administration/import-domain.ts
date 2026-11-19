import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

/**
 * Legacy CSV inventory uploads (`pos_csv_upload`) and the Python semantics their Celery tasks
 * depend on: `csv.DictReader`, `int()`, `repr()` and `json.dumps` (`helpers/task_helpers.py:64-350`).
 */
export const uploadTypes = ['PRODUCT_STOCK_CSV', 'PRODUCT_STORE_CSV'] as const;
export const uploadType = z.enum(uploadTypes);
export type UploadType = z.infer<typeof uploadType>;

/** Request bound (the JSON body limit); legacy has none. */
export const maximumImportBytes = 256 * 1024;

/** Legacy form: `FileField` + `validate_file_extension` (`name.endswith('.csv')`, case-sensitive). */
export const csvUploadInput = z
  .object({
    type: uploadType,
    name: z
      .string()
      .min(5)
      .max(255)
      .regex(/^[^\p{C}\\/]+\.csv$/u, 'Only CSV file is accepted'),
    csv: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= maximumImportBytes,
        'Choose a CSV file up to 256 KiB.',
      ),
  })
  .strict();
export type CsvUploadInput = z.infer<typeof csvUploadInput>;
export const uploadIdInput = z.object({ uploadId: identifier }).strict();
export const uploadListInput = z
  .object({
    type: uploadType.optional(),
    before: identifier.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const templateInput = z.object({ type: uploadType }).strict();

/** `ProductsStoreBulkUploadView` / `ProductsStockBulkUploadView` download rows (`core/views.py:146-151,405-411`). */
export const templates: Record<
  UploadType,
  { prefix: string; rows: readonly (readonly string[])[] }
> = {
  PRODUCT_STORE_CSV: {
    prefix: 'ProductStore-',
    rows: [
      ['SkuId', 'StoreId', 'IsActive'],
      [
        'Enter only parent product ids (variants product ids are not allowed)',
        'For store ids please refer instructions on the store bulk upload page',
        '1=>Active and 0=>Delete',
      ],
      ['1234', '1', '1'],
    ],
  },
  PRODUCT_STOCK_CSV: {
    prefix: 'ProductStock-',
    rows: [
      ['SkuId', 'StoreId', 'IsHold', 'Hold/UnholdQty', 'IsAvailable', 'IsDelete'],
      [
        'Enter parent product ids only for simple products and for configurable only variant SKU ID will be used.)',
        'For store ids please refer instructions on the store bulk upload page',
        '1=>For Hold | 0=> For Unhold',
        'Hold/Unhold Quantity',
        '0=>Product listing off | 1=>Product listing on',
        '0=>Activate Product | 1=>Deactivate Product',
      ],
      ['1234', '1', '1', '8', '1', '0'],
    ],
  },
};

/** Python `csv.writer` (excel dialect, QUOTE_MINIMAL, `\r\n`). */
export function pythonCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map(
      (row) =>
        row
          .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
          .join(',') + '\r\n',
    )
    .join('');
}

/** A Python exception, reproduced by type and `str()` message. */
export class PythonError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/** Python `repr()` of a `str`. */
export function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '\\') out += '\\\\';
    else if (character === quote) out += '\\' + quote;
    else if (character === '\n') out += '\\n';
    else if (character === '\r') out += '\\r';
    else if (character === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else if (code >= 0x80 && code < 0xa0) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += character;
  }
  return out + quote;
}

/** Python `int(value)` for a CSV cell (`str`) or a missing cell (`None`). */
export function pythonInt(value: string | null): bigint {
  if (value === null)
    throw new PythonError(
      'TypeError',
      "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
    );
  const text = value.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(text))
    throw new PythonError(
      'ValueError',
      `invalid literal for int() with base 10: ${pythonRepr(value)}`,
    );
  return BigInt(text.replace(/_/g, ''));
}

/** JSON value as `json.dumps` sees it (dicts keep insertion order). */
export type PythonJson =
  null | string | number | boolean | readonly PythonJson[] | { readonly [key: string]: PythonJson };

/** Python `json.dumps(value)` with its defaults: `ensure_ascii=True`, `", "` and `": "`. */
export function pythonJsonDumps(value: PythonJson): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    let out = '"';
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index),
        character = value[index]!;
      if (character === '"') out += '\\"';
      else if (character === '\\') out += '\\\\';
      else if (character === '\n') out += '\\n';
      else if (character === '\r') out += '\\r';
      else if (character === '\t') out += '\\t';
      else if (character === '\b') out += '\\b';
      else if (character === '\f') out += '\\f';
      else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += character;
    }
    return out + '"';
  }
  if (Array.isArray(value)) return '[' + value.map(pythonJsonDumps).join(', ') + ']';
  const entries = Object.entries(value as { readonly [key: string]: PythonJson });
  return (
    '{' +
    entries.map(([key, item]) => `${pythonJsonDumps(key)}: ${pythonJsonDumps(item)}`).join(', ') +
    '}'
  );
}

/**
 * Python `csv.reader` (excel dialect, `strict=False`) over `response.readlines()`: lines split
 * after `\n` only. A lone `\r` followed by more data raises in Python while iterating, after the
 * rows before it were handed out; `error` carries that failure.
 */
export function pythonCsvRows(text: string): { rows: string[][]; error: PythonError | null } {
  const lines = text.split(/(?<=\n)/).filter((line) => line.length > 0);
  const rows: string[][] = [];
  type State = 'record' | 'field' | 'in' | 'quoted' | 'quote' | 'crnl';
  let state: State = 'record',
    fields: string[] = [],
    field = '',
    fieldLength = 0;
  const save = () => {
    fields.push(field);
    field = '';
    fieldLength = 0;
  };
  const add = (character: string) => {
    field += character;
    fieldLength++;
  };
  const process = (character: string | null) => {
    const eol = character === null,
      newline = character === '\n' || character === '\r';
    switch (state) {
      case 'record':
        if (eol) return;
        if (newline) {
          state = 'crnl';
          return;
        }
        state = 'field';
        return process(character);
      case 'field':
        if (eol || newline) {
          save();
          state = eol ? 'record' : 'crnl';
        } else if (character === '"') state = 'quoted';
        else if (character === ',') save();
        else {
          add(character);
          state = 'in';
        }
        return;
      case 'in':
        if (eol || newline) {
          save();
          state = eol ? 'record' : 'crnl';
        } else if (character === ',') {
          save();
          state = 'field';
        } else add(character);
        return;
      case 'quoted':
        if (eol) return;
        if (character === '"') state = 'quote';
        else add(character);
        return;
      case 'quote':
        if (character === '"') {
          add('"');
          state = 'quoted';
        } else if (character === ',') {
          save();
          state = 'field';
        } else if (eol || newline) {
          save();
          state = eol ? 'record' : 'crnl';
        } else {
          add(character);
          state = 'in';
        }
        return;
      case 'crnl':
        if (newline) return;
        if (eol) {
          state = 'record';
          return;
        }
        throw new PythonError('Error', 'new-line character seen in unquoted field');
    }
  };
  try {
    for (const line of lines) {
      for (const character of line) process(character);
      process(null);
      if (state === 'record') {
        rows.push(fields);
        fields = [];
      }
    }
  } catch (error) {
    if (error instanceof PythonError) return { rows, error };
    throw error;
  }
  if (state !== 'record' && (fieldLength !== 0 || state === 'quoted')) {
    save();
    rows.push(fields);
  }
  return { rows, error: null };
}

/** One `csv.DictReader` row: missing cells are `None` (`restval`), extra cells are ignored. */
export type CsvRecord = ReadonlyMap<string, string | null>;
/**
 * Python `csv.DictReader(lines)`: the first row names the fields; blank rows are skipped.
 * `error` is raised after `records` have been handed out (or before any, from the header row).
 */
export function pythonDictRows(text: string): { records: CsvRecord[]; error: PythonError | null } {
  const parsed = pythonCsvRows(text),
    [fieldnames, ...rows] = parsed.rows;
  if (!fieldnames) return { records: [], error: parsed.error };
  const records = rows
    .filter((row) => row.length > 0)
    .map((row) => {
      const record = new Map<string, string | null>();
      fieldnames.forEach((name, index) => {
        if (index < row.length) record.set(name, row[index]!);
      });
      for (const name of fieldnames.slice(row.length)) record.set(name, null);
      return record;
    });
  return { records, error: parsed.error };
}

/** Columns each task reads by name before its `try` body can recover (`row_dict`). */
export const requiredColumns: Record<UploadType, readonly string[]> = {
  PRODUCT_STORE_CSV: ['SkuId', 'StoreId', 'IsActive'],
  PRODUCT_STOCK_CSV: ['SkuId', 'StoreId', 'IsHold', 'Hold/UnholdQty', 'IsAvailable', 'IsDelete'],
};

/** One entry of `pos_csv_upload.failed_data` (key order as the source `dict.update`). */
export interface FailedRecord {
  data: Record<string, string | null>;
  message: string;
  other_error?: string;
}
export const failedRecord = z
  .object({
    data: z.record(z.string(), z.string().nullable()),
    message: z.string(),
    other_error: z.string().optional(),
  })
  .strict();
export const failedData = z.array(failedRecord);

/** Messages written by the source tasks (`helpers/task_helpers.py`). */
export const importMessages = {
  storeDone: 'Product Store Data Updated Successfully.',
  stockDone: 'Product Stock Data Updated Successfully.',
  invalidStore: 'Not a valid store.',
  notParent: 'Not a parent product.',
  storeDenied: 'Not a valid store for requested user.',
  missing: 'Required parameters are missing.',
  traversal: 'Error while traversing csv data.',
  noHoldStock: 'Stock is not available to hold.',
  /** Rewrite-only: the progress cursor was lost, so the upload is closed instead of re-applied. */
  interrupted:
    'Import was interrupted and has not been resumed. Please upload the remaining records again.',
  uploaded: 'Csv Uploaded successfully. Data may take some time to reflect.',
} as const;

/** Redis progress cursor `pos:import_progress:{uploadId}` (ledger), EX 7 days. */
export const importProgressKey = (uploadId: string) => `pos:import_progress:${uploadId}`;
export const importProgressTtlSeconds = 7 * 24 * 60 * 60;
export const importProgress = z
  .object({
    /** Last processed record number (1-based data rows; 0 before the first). */
    record: z.number().int().min(0),
    failed: failedData,
    /** Source `product_id_list` for the final `sync_pos_product` call, in order, with repeats. */
    productIds: z.array(z.string().regex(/^-?\d+$/)),
    /** Source `records_to_be_inserted` (product-store task), inserted together at the end. */
    inserts: z.array(z.tuple([identifier, identifier])),
  })
  .strict();
export type ImportProgress = z.infer<typeof importProgress>;
export const initialProgress = (): ImportProgress => ({
  record: 0,
  failed: [],
  productIds: [],
  inserts: [],
});
