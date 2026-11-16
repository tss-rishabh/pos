import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';

export const offlineOrderColumns = [
  'SerialNo',
  'StoreId',
  'Email',
  'UserName',
  'IsExclusive',
  'ProductId',
  'ProductQty',
  'ProductPrice',
  'PaymentMode',
  'OrderDate',
  'OrderPlacedSms',
  'OrderMessage',
] as const;
export const shopifyOrderColumns = [
  'Name',
  'Email',
  'Financial Status',
  'Currency',
  'Subtotal',
  'Shipping',
  'Taxes',
  'Total',
  'Discount Code',
  'Discount Amount',
  'Created at',
  'Lineitem quantity',
  'Lineitem name',
  'Lineitem price',
  'Lineitem compare at price',
  'Lineitem sku',
  'Lineitem taxable',
  'Shipping Name',
  'Shipping Street',
  'Shipping Address1',
  'Shipping Address2',
  'Shipping Company',
  'Shipping City',
  'Shipping Zip',
  'Shipping Province',
  'Shipping Country',
  'Shipping Phone',
  'Payment Method',
  'Lineitem discount',
  'Tax 1 Name',
  'Tax 1 Value',
  'Phone',
] as const;

const limits = { bytes: 5 * 1024 * 1024, rows: 50000, recordBytes: 128 * 1024 } as const;
const rowSchema = z.record(z.string(), z.string());
type CsvRow = z.infer<typeof rowSchema>;
export interface LegacyImportLine {
  row: number;
  productId: string;
  quantity: string;
  price: string;
}
export interface LegacyImportGroup {
  sequence: number;
  firstRow: number;
  reference: string;
  details: Readonly<Record<string, string>>;
  address: Readonly<Record<string, string>> | null;
  lines: LegacyImportLine[];
}
function invalid(code: string, message: string): never {
  throw new AppError(422, code, message);
}

function readRows(csv: string, required: readonly string[]): CsvRow[] {
  if (Buffer.byteLength(csv, 'utf8') > limits.bytes)
    invalid('ORDER_IMPORT_TOO_LARGE', 'The order import exceeds the file-size limit.');
  let headerChecked = false;
  let rowCount = 0;
  try {
    const raw: unknown = parse(csv, {
      bom: true,
      columns: (headers: string[]) => {
        if (
          new Set(headers).size !== headers.length ||
          required.some((name) => !headers.includes(name))
        )
          invalid(
            'ORDER_IMPORT_HEADERS_INVALID',
            'Use the required order import headers without duplicate columns.',
          );
        headerChecked = true;
        return headers;
      },
      max_record_size: limits.recordBytes,
      skip_empty_lines: true,
      relax_column_count: false,
      on_record: (record: unknown) => {
        if (++rowCount > limits.rows)
          invalid('ORDER_IMPORT_TOO_LARGE', 'The order import exceeds the row limit.');
        return record;
      },
    });
    const rows = z.array(rowSchema).parse(raw);
    if (!headerChecked || !rows.length)
      invalid('ORDER_IMPORT_EMPTY', 'The order import contains no order rows.');
    if (rows.length > limits.rows)
      invalid('ORDER_IMPORT_TOO_LARGE', 'The order import exceeds the row limit.');
    return rows;
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Parser exceptions contain input fragments; expose only a fixed message.
    return invalid('ORDER_IMPORT_CSV_INVALID', 'The order import is not valid UTF-8 CSV.');
  }
}
function field(row: CsvRow, name: string): string {
  const value = row[name];
  if (value === undefined)
    return invalid('ORDER_IMPORT_HEADERS_INVALID', 'A required order import column is missing.');
  return value;
}
function line(row: CsvRow, rowNumber: number, kind: 'offline' | 'shopify'): LegacyImportLine {
  return kind === 'offline'
    ? {
        row: rowNumber,
        productId: field(row, 'ProductId'),
        quantity: field(row, 'ProductQty'),
        price: field(row, 'ProductPrice'),
      }
    : {
        row: rowNumber,
        productId: field(row, 'Lineitem sku'),
        quantity: field(row, 'Lineitem quantity'),
        price: field(row, 'Lineitem price'),
      };
}

/** Retains the literal source grouping, without looking up customers or creating orders. */
export function groupOfflineOrderCsv(csv: string): LegacyImportGroup[] {
  const groups: LegacyImportGroup[] = [];
  let current: LegacyImportGroup | undefined;
  for (const [index, row] of readRows(csv, offlineOrderColumns).entries()) {
    const rowNumber = index + 2;
    if (field(row, 'SerialNo')) {
      current = {
        sequence: groups.length + 1,
        firstRow: rowNumber,
        reference: field(row, 'SerialNo'),
        details: {
          order_date: field(row, 'OrderDate'),
          store_id: field(row, 'StoreId'),
          email: field(row, 'Email'),
          user_name: field(row, 'UserName'),
          is_exclusive: field(row, 'IsExclusive'),
          payment_mode: field(row, 'PaymentMode'),
          order_placed_sms: field(row, 'OrderPlacedSms'),
          order_message: field(row, 'OrderMessage'),
        },
        address: null,
        lines: [],
      };
      groups.push(current);
    }
    if (!current)
      invalid('ORDER_IMPORT_ORPHAN_LINE', 'Every order must begin with a serial-number row.');
    current.lines.push(line(row, rowNumber, 'offline'));
  }
  return groups;
}

/** Shopify repeats a Name for adjacent lines; a changed nonempty Name starts another order. */
export function groupShopifyOrderCsv(csv: string, storeId: string): LegacyImportGroup[] {
  const scope = identifier.parse(storeId),
    groups: LegacyImportGroup[] = [];
  let current: LegacyImportGroup | undefined,
    previous = '';
  for (const [index, row] of readRows(csv, shopifyOrderColumns).entries()) {
    const rowNumber = index + 2,
      reference = field(row, 'Name');
    if (reference && reference !== previous) {
      current = {
        sequence: groups.length + 1,
        firstRow: rowNumber,
        reference,
        details: {
          shopify_order_id: reference,
          order_date: field(row, 'Created at'),
          store_id: scope,
          email: field(row, 'Email'),
          shipping_charges: field(row, 'Shipping'),
          tax_name: field(row, 'Tax 1 Name'),
          tax_value: field(row, 'Tax 1 Value'),
          financial_status: field(row, 'Financial Status'),
          currency: field(row, 'Currency'),
          subtotal: field(row, 'Subtotal'),
          taxes: field(row, 'Taxes'),
          total: field(row, 'Total'),
          discount_code: field(row, 'Discount Code'),
          discount_amount: field(row, 'Discount Amount'),
          payment_method: field(row, 'Payment Method'),
        },
        address: {
          shipping_name: field(row, 'Shipping Name'),
          shipping_street: field(row, 'Shipping Street'),
          shipping_address1: field(row, 'Shipping Address1'),
          shipping_address2: field(row, 'Shipping Address2'),
          shipping_city: field(row, 'Shipping City'),
          shipping_zip: field(row, 'Shipping Zip'),
          shipping_province: field(row, 'Shipping Province'),
          shipping_country: field(row, 'Shipping Country'),
          shipping_phone: field(row, 'Shipping Phone'),
        },
        lines: [],
      };
      groups.push(current);
    }
    if (!current)
      invalid('ORDER_IMPORT_ORPHAN_LINE', 'Every Shopify order must begin with a named order row.');
    current.lines.push(line(row, rowNumber, 'shopify'));
    previous = reference;
  }
  return groups;
}
