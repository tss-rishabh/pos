import { z } from 'zod';
import { total } from '../../lib/format';

const id = z
  .string()
  .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const maximumCents = 100_000_000_000n;
const label = z
  .string()
  .max(256)
  .refine((value) => !/[\p{C}]/u.test(value));
const decimal = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return `${BigInt(whole!)}.${fraction.padEnd(2, '0')}`;
  })
  .refine((value) => cents(value) <= maximumCents);
const quantity = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .refine((value) => value >= 1 && value <= 999);
const lineInput = z
  .object({
    productId: id,
    name: z.string().min(1).max(512),
    quantity,
    unitPrice: decimal,
  })
  .strict();
export interface WorksheetLine {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: string;
}
export interface Worksheet {
  storeId: string;
  createdAt: number;
  serialNo: string;
  customerName: string;
  customerEmail: string;
  lines: WorksheetLine[];
}
export const worksheetCsvHeaders = [
  'SerialNo',
  'StoreId',
  'Email',
  'UserName',
  'IsExclusive',
  'ProductId',
  'ProductQty',
  'ProductPrice',
  'TotalProductPrice',
  'TotalPrice',
  'PaymentMode',
  'OrderDate',
  'OrderMessage',
  'OrderPlacedSms',
] as const;
export function createWorksheet(storeId: string, createdAt = Date.now()): Worksheet {
  id.parse(storeId);
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isFinite(new Date(createdAt).getTime())
  )
    throw new Error('The worksheet time is invalid.');
  return {
    storeId,
    createdAt,
    serialNo: `${createdAt}${storeId}`,
    customerName: '',
    customerEmail: '',
    lines: [],
  };
}
function cents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function addWorksheetLine(sheet: Worksheet, input: unknown): Worksheet {
  const parsed = lineInput.safeParse(input);
  if (!parsed.success)
    throw new Error(
      'Choose a product, a whole quantity from 1 to 999, and a price with up to two decimal places.',
    );
  const line = { ...parsed.data, id: crypto.randomUUID() },
    lines = [...sheet.lines, line];
  if (
    lines.reduce((sum, item) => sum + item.quantity, 0) > 999 ||
    cents(total(lines)) > maximumCents
  )
    throw new Error('A worksheet supports at most 999 units and a total of ₹1,00,00,00,000.00.');
  return { ...sheet, lines };
}
export function removeWorksheetLine(sheet: Worksheet, lineId: string): Worksheet {
  return { ...sheet, lines: sheet.lines.filter((line) => line.id !== lineId) };
}
export const worksheetTotal = (sheet: Worksheet) => total(sheet.lines);
export function worksheetAmounts(sheet: Worksheet) {
  const value = worksheetTotal(sheet),
    minor = cents(value);
  return {
    total: value,
    rounding: `0.${String(minor % 100n).padStart(2, '0')}`,
    rounded: `${minor / 100n}.00`,
  };
}
export function validateWorksheet(sheet: Worksheet): Worksheet {
  if (!sheet.lines.length) throw new Error('Add at least one product to the worksheet.');
  if (
    !label.safeParse(sheet.customerName).success ||
    !(sheet.customerEmail === '' || z.email().max(254).safeParse(sheet.customerEmail).success)
  )
    throw new Error('Use a valid customer label and email, or leave them blank.');
  return sheet;
}
function csvCell(value: string) {
  if (/^[\s]*[=+@-]/u.test(value))
    throw new Error(
      'A spreadsheet field starts with an unsafe character. Change the customer label or email before exporting.',
    );
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
/** Original fourteen-column import format. Continuation rows retain empty metadata. */
export function worksheetCsv(sheet: Worksheet): string {
  validateWorksheet(sheet);
  const timestamp = new Date(sheet.createdAt).toISOString().slice(0, 19).replace('T', ' '),
    sum = worksheetTotal(sheet);
  const rows = sheet.lines.map((line, index) => [
    index === 0 ? sheet.serialNo : '',
    index === 0 ? sheet.storeId : '',
    index === 0 ? sheet.customerEmail : '',
    index === 0 ? sheet.customerName : '',
    index === 0 ? '0' : '',
    line.productId,
    String(line.quantity),
    line.unitPrice,
    total([line]),
    index === 0 ? sum : '',
    index === 0 ? 'cash' : '',
    index === 0 ? timestamp : '',
    index === 0 ? 'offline billed' : '',
    index === 0 ? '0' : '',
  ]);
  return [worksheetCsvHeaders, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}
