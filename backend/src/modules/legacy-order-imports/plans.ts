import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { amount, minorUnits } from '../../domain/money.js';
import { identifier } from '../../domain/validation.js';
import { isLegacyLatinText } from '../checkout/settlement-note.js';
import type { LegacyImportGroup } from './csv.js';

const maximumCents = 100_000_000_000n;
const maximumQuantity = 999;
const email = z.email().max(254);
const datePattern = /^[1-9]\d{3}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d$/;

export interface ImportedOrderLine {
  productId: string;
  quantity: number;
  unitPrice: string;
  sourceRows: readonly number[];
}
interface OrderPlan {
  sequence: number;
  firstRow: number;
  reference: string;
  storeId: string;
  email: string | null;
  createdAt: string;
  lines: ImportedOrderLine[];
  originalTenderAmount: string;
}
export interface OfflineOrderImportPlan extends OrderPlan {
  kind: 'offline';
  payment: 'cash' | 'manual-other';
  sendOrderPlacedSms: boolean;
  message: string;
}
export interface ShopifyOrderImportPlan extends OrderPlan {
  kind: 'shopify';
  email: string;
  payment: 'shopify';
  currency: string;
  address: Readonly<Record<string, string>>;
  /** Literal source payload, not a claim about the tax calculated by API-v2. */
  legacyTaxDigit: number;
  shippingCharges: string;
  discountAmount: string;
  financialStatus: string;
  declaredSubtotal: string;
  declaredTaxes: string;
  declaredTotal: string;
}
export type LegacyOrderImportPlan = OfflineOrderImportPlan | ShopifyOrderImportPlan;

function invalid(code: string, message: string): never {
  throw new AppError(422, code, message);
}
function field(group: LegacyImportGroup, name: string): string {
  const value = group.details[name];
  if (value === undefined)
    invalid('ORDER_IMPORT_METADATA_INVALID', 'An order has incomplete import metadata.');
  return value;
}
function canonicalId(value: string): string {
  const text = value.trim();
  if (!/^\d{1,20}$/.test(text))
    invalid('ORDER_IMPORT_IDENTIFIER_INVALID', 'Use a valid positive store or product identifier.');
  const parsed = identifier.safeParse(BigInt(text).toString());
  if (!parsed.success)
    invalid('ORDER_IMPORT_IDENTIFIER_INVALID', 'Use a valid positive store or product identifier.');
  return parsed.data;
}
function currencyAmount(value: string, positive = false): bigint {
  const text = value.trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text))
    invalid('ORDER_IMPORT_AMOUNT_INVALID', 'Use a finite amount with at most two decimal places.');
  const cents = minorUnits(text);
  if (cents > maximumCents || (positive && cents === 0n))
    invalid('ORDER_IMPORT_AMOUNT_INVALID', 'The order amount is outside the supported range.');
  return cents;
}

/** API-v2 consumes an India wall-clock string, never an implicit host-local Date. */
export function importedOrderDate(value: string, kind: 'offline' | 'shopify'): string {
  try {
    if (kind === 'offline') {
      if (!datePattern.test(value)) throw new Error();
      const date = Temporal.PlainDateTime.from(value.replace(' ', 'T'), { overflow: 'reject' });
      if (date.year < 1970) throw new Error();
      return date.toString({ smallestUnit: 'second' }).replace('T', ' ');
    }
    const match = /^(.{19}) (Z|[+-]\d{2}:?\d{2})$/.exec(value);
    if (!match?.[1] || !match[2] || !datePattern.test(match[1])) throw new Error();
    Temporal.PlainDateTime.from(match[1].replace(' ', 'T'), { overflow: 'reject' });
    const offset = match[2].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const converted = Temporal.Instant.from(match[1].replace(' ', 'T') + offset)
      .toZonedDateTimeISO('Asia/Kolkata')
      .toPlainDateTime();
    if (converted.year < 1970 || converted.year > 9999) throw new Error();
    return converted.toString({ smallestUnit: 'second' }).replace('T', ' ');
  } catch {
    return invalid(
      'ORDER_IMPORT_DATE_INVALID',
      'Use a valid order date and the required time-zone format.',
    );
  }
}

function customerEmail(value: string, required: boolean): string | null {
  if (!value && !required) return null;
  const parsed = email.safeParse(value);
  if (!parsed.success)
    invalid('ORDER_IMPORT_EMAIL_INVALID', 'Use a valid customer email for this order.');
  return parsed.data;
}
function unsafeText(value: string): boolean {
  return /[\p{C}]/u.test(value.replaceAll('\n', '').replaceAll('\r', '').replaceAll('\t', ''));
}
function orderLines(group: LegacyImportGroup) {
  if (!group.lines.length || group.lines.length > maximumQuantity)
    invalid(
      'ORDER_IMPORT_QUANTITY_INVALID',
      'An imported order must contain between 1 and 999 units.',
    );
  const lines = new Map<string, ImportedOrderLine>();
  let total = 0n,
    totalQuantity = 0;
  for (const row of group.lines) {
    const productId = canonicalId(row.productId),
      quantityText = row.quantity.trim();
    if (!/^\d{1,3}$/.test(quantityText) || Number(quantityText) < 1)
      invalid('ORDER_IMPORT_QUANTITY_INVALID', 'Use a whole product quantity between 1 and 999.');
    const quantity = Number(quantityText),
      unitCents = currencyAmount(row.price, true),
      unitPrice = amount(unitCents),
      previous = lines.get(productId);
    // The source overwrites a product-wide price while accumulating the earlier tender.
    // Refuse that inconsistent order before dispatch rather than selecting either amount.
    if (previous && previous.unitPrice !== unitPrice)
      invalid(
        'ORDER_IMPORT_PRICE_REVIEW',
        'Repeated products with different prices require review.',
      );
    totalQuantity += quantity;
    total += unitCents * BigInt(quantity);
    if (totalQuantity > maximumQuantity || total > maximumCents)
      invalid('ORDER_IMPORT_TOTAL_INVALID', 'The imported order exceeds its unit or amount limit.');
    lines.set(productId, {
      productId,
      quantity: (previous?.quantity ?? 0) + quantity,
      unitPrice,
      sourceRows: [...(previous?.sourceRows ?? []), row.row],
    });
  }
  return { lines: [...lines.values()], originalTenderAmount: amount(total) };
}
function base(group: LegacyImportGroup, kind: 'offline' | 'shopify'): OrderPlan {
  if (
    !Number.isSafeInteger(group.sequence) ||
    group.sequence < 1 ||
    !Number.isSafeInteger(group.firstRow) ||
    group.firstRow < 2
  )
    invalid('ORDER_IMPORT_METADATA_INVALID', 'The order import sequence is invalid.');
  if (!group.reference || group.reference.length > 255 || /[\p{C}]/u.test(group.reference))
    invalid(
      'ORDER_IMPORT_REFERENCE_INVALID',
      'Use a bounded order reference without control characters.',
    );
  return {
    sequence: group.sequence,
    firstRow: group.firstRow,
    reference: group.reference,
    storeId: canonicalId(field(group, 'store_id')),
    email: customerEmail(field(group, 'email'), kind === 'shopify'),
    createdAt: importedOrderDate(field(group, 'order_date'), kind),
    ...orderLines(group),
  };
}

export function offlineOrderImportPlan(group: LegacyImportGroup): OfflineOrderImportPlan {
  const plan = base(group, 'offline'),
    sms = field(group, 'order_placed_sms').trim(),
    message = field(group, 'order_message');
  if (!['0', '1'].includes(sms))
    invalid('ORDER_IMPORT_SMS_INVALID', 'OrderPlacedSms must be 0 or 1.');
  if (message.length > 255 || unsafeText(message) || !isLegacyLatinText(message))
    invalid('ORDER_IMPORT_MESSAGE_INVALID', 'The order message exceeds the supported text limits.');
  return {
    ...plan,
    kind: 'offline',
    payment: field(group, 'payment_mode').toLowerCase() === 'cash' ? 'cash' : 'manual-other',
    sendOrderPlacedSms: sms === '1',
    message,
  };
}

export function shopifyOrderImportPlan(group: LegacyImportGroup): ShopifyOrderImportPlan {
  const plan = base(group, 'shopify'),
    tax = /[0-9]/.exec(field(group, 'tax_name')),
    currency = field(group, 'currency') || 'INR',
    address = group.address;
  if (!tax || !/^[A-Z]{3}$/.test(currency) || !plan.email || !address)
    invalid(
      'ORDER_IMPORT_SHOPIFY_METADATA_INVALID',
      'The Shopify currency, tax label or address is incomplete.',
    );
  for (const [key, value] of Object.entries(address))
    if (!key.startsWith('shipping_') || value.length > 1000 || unsafeText(value))
      invalid(
        'ORDER_IMPORT_ADDRESS_INVALID',
        'The shipping address exceeds the supported text limits.',
      );
  return {
    ...plan,
    email: plan.email,
    kind: 'shopify',
    payment: 'shopify',
    currency,
    address: { ...address },
    legacyTaxDigit: Number(tax[0]),
    shippingCharges: amount(currencyAmount(field(group, 'shipping_charges') || '0')),
    discountAmount: amount(currencyAmount(field(group, 'discount_amount'))),
    financialStatus: field(group, 'financial_status'),
    declaredSubtotal: amount(currencyAmount(field(group, 'subtotal'))),
    declaredTaxes: amount(currencyAmount(field(group, 'taxes'))),
    declaredTotal: amount(currencyAmount(field(group, 'total'))),
  };
}
