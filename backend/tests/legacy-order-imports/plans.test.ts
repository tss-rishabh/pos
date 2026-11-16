import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LegacyImportGroup } from '../../src/modules/legacy-order-imports/csv.js';
import {
  importedOrderDate,
  offlineOrderImportPlan,
  shopifyOrderImportPlan,
} from '../../src/modules/legacy-order-imports/plans.js';

const oracle = fileURLToPath(
  new URL('../../tools/legacy-order-imports/source_order.py', import.meta.url),
);
function group(kind: 'offline' | 'shopify' = 'offline'): LegacyImportGroup {
  return {
    sequence: 1,
    firstRow: 2,
    reference: '#fixture',
    details: {
      store_id: '1',
      order_date: kind === 'offline' ? '2026-06-15 12:00:00' : '2026-06-15 06:30:00 +0000',
      email: 'buyer@example.test',
      user_name: 'Unused fixture',
      is_exclusive: '1',
      payment_mode: 'cash',
      order_placed_sms: '0',
      order_message: 'Fixture import',
      shipping_charges: '0',
      tax_name: 'GST 18%',
      tax_value: '18',
      financial_status: 'paid',
      currency: 'INR',
      subtotal: '50.98',
      taxes: '0',
      total: '50.98',
      discount_code: '',
      discount_amount: '0',
      payment_method: 'Cash',
    },
    address:
      kind === 'offline'
        ? null
        : {
            shipping_name: 'Fixture recipient',
            shipping_street: 'Fixture street',
            shipping_address1: '',
            shipping_address2: '',
            shipping_city: 'Fixture city',
            shipping_zip: '400001',
            shipping_province: 'MH',
            shipping_country: 'IN',
            shipping_phone: '',
          },
    lines: [{ row: 2, productId: '9007199254740993', quantity: '2', price: '25.49' }],
  };
}
interface SourceCall {
  event: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
}
function source(kind: 'offline' | 'shopify', input: LegacyImportGroup) {
  const result = spawnSync('python3', [oracle], {
    input: JSON.stringify({
      kind,
      group: {
        order_details: [input.details],
        line_item: input.lines.map((row) => ({
          product_id: row.productId,
          product_qty: row.quantity,
          product_price: row.price,
        })),
        ...(input.address ? { address: [input.address] } : {}),
      },
    }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  expect(result.status, 'The exact source order body must execute against isolated captors.').toBe(
    0,
  );
  const value = JSON.parse(result.stdout) as { calls: SourceCall[]; failureCount: number };
  expect(value.failureCount).toBe(0);
  return value.calls;
}
describe('validated legacy import plans against literal source order methods', () => {
  it.each(['cash', 'CASH', ' cash ', '', 'Card'])(
    'preserves the original %j tender branch and custom order date',
    (mode) => {
      const input = group();
      input.details = { ...input.details, payment_mode: mode };
      const plan = offlineOrderImportPlan(input),
        calls = source('offline', input),
        completion = calls.find((call) => call.event === 'complete'),
        order = calls.find((call) => call.event === 'order');
      expect(plan.createdAt).toBe(order?.kwargs.order_date);
      expect(plan.payment).toBe(mode.toLowerCase() === 'cash' ? 'cash' : 'manual-other');
      expect(completion?.args[3]).toBe(
        plan.payment === 'cash' ? Number(plan.originalTenderAmount) : 0,
      );
      expect(completion?.args[5]).toBe(
        plan.payment === 'cash' ? 0 : Number(plan.originalTenderAmount),
      );
      expect(completion?.kwargs.custom_date).toBe(plan.createdAt);
      expect(Boolean(completion?.kwargs.others)).toBe(plan.payment === 'manual-other');
      expect(calls.filter((call) => call.event === 'add')).toHaveLength(2);
      expect(calls.some((call) => call.event === 'sms')).toBe(false);
    },
  );
  it('preserves explicit SMS selection and optional guest fallback without retaining unused names', () => {
    const input = group();
    input.details = { ...input.details, email: '', order_placed_sms: '1' };
    const plan = offlineOrderImportPlan(input),
      calls = source('offline', input);
    expect(plan.email).toBeNull();
    expect(plan.sendOrderPlacedSms).toBe(true);
    expect(calls.filter((call) => call.event === 'sms')).toHaveLength(1);
    expect(plan).not.toHaveProperty('user_name');
    expect(plan).not.toHaveProperty('is_exclusive');
  });
  it('aggregates equal-priced duplicate products without converting full-width identifiers to numbers', () => {
    const input = group();
    input.lines.push({
      row: 3,
      productId: '9007199254740993',
      quantity: '3',
      price: '25.49',
    });
    const plan = offlineOrderImportPlan(input);
    expect(plan.lines).toEqual([
      { productId: '9007199254740993', quantity: 5, unitPrice: '25.49', sourceRows: [2, 3] },
    ]);
    expect(plan.originalTenderAmount).toBe('127.45');
    expect(source('offline', input).filter((call) => call.event === 'add')).toHaveLength(5);
  });
  it('refuses the proven product-wide price overwrite defect before any financial operation', () => {
    const input = group();
    input.lines.push({ row: 3, productId: '9007199254740993', quantity: '1', price: '20' });
    const legacy = source('offline', input),
      finalCart = legacy.find((call) => call.event === 'cart');
    expect(finalCart?.kwargs.custom_data).toEqual({ price: { '9007199254740993': 20 } });
    expect(legacy.find((call) => call.event === 'complete')?.args[3]).toBe(70.97999999999999);
    expect(() => offlineOrderImportPlan(input)).toThrow('different prices require review');
  });
  it.each(['GST 5%', 'GST 18%'])(
    'retains the literal %s Shopify payload and its separate stock/publication flow',
    (label) => {
      const input = group('shopify');
      input.details = { ...input.details, tax_name: label, currency: '' };
      const plan = shopifyOrderImportPlan(input),
        calls = source('shopify', input),
        order = calls.find((call) => call.event === 'order');
      expect(plan.createdAt).toBe('2026-06-15 12:00:00');
      expect(order?.kwargs.order_date).toBe(plan.createdAt);
      expect(order?.args[3]).toBe('shopify');
      expect(order?.kwargs.custom_data).toEqual({
        price: { '9007199254740993': 25.49 },
        tax: plan.legacyTaxDigit,
        shipping_charges: 0,
        is_shopify_order: 1,
        currency: plan.currency,
        discount_amount: 0,
        address: plan.address,
      });
      expect(calls.filter((call) => ['confirm', 'complete'].includes(call.event))).toEqual([]);
      expect(calls.slice(-2).map((call) => call.event)).toEqual(['stock', 'publish']);
    },
  );
  it('converts positive, negative and colon offsets across India date boundaries', () => {
    for (const [input, expected] of [
      ['2026-06-15 23:30:00 -0400', '2026-06-16 09:00:00'],
      ['2026-06-15 01:00:00 +1400', '2026-06-14 16:30:00'],
      ['2024-02-29 12:00:00 +05:30', '2024-02-29 12:00:00'],
    ]) {
      expect(importedOrderDate(input!, 'shopify')).toBe(expected);
      const value = group('shopify');
      value.details = { ...value.details, order_date: input! };
      expect(
        source('shopify', value).find((call) => call.event === 'order')?.kwargs.order_date,
      ).toBe(expected);
    }
  });
  it.each(['0', '-1', '1.5', '1000', 'Infinity', 'NaN', '9007199254740993'])(
    'rejects invalid quantity %j before an upstream request',
    (quantity) => {
      const input = group();
      input.lines[0]!.quantity = quantity;
      expect(() => offlineOrderImportPlan(input)).toThrow('quantity');
    },
  );
  it.each(['-1', 'NaN', 'Infinity', '1e2', '1.001', '0', '99999999999'])(
    'rejects invalid price %j with fixed diagnostics',
    (price) => {
      const input = group();
      input.lines[0]!.price = price;
      expect(() => offlineOrderImportPlan(input)).toThrow(/amount/);
    },
  );
  it('rejects invalid calendar dates, invalid addresses and missing required Shopify customers', () => {
    for (const date of [
      '2025-02-29 12:00:00',
      '2026-13-01 12:00:00',
      '2026-06-15 24:00:00',
      '2026-06-15 12:00:60',
      '1900-06-15 12:00:00',
    ])
      expect(() => importedOrderDate(date, 'offline')).toThrow('valid order date');
    const input = group('shopify');
    input.details = { ...input.details, email: '' };
    expect(() => shopifyOrderImportPlan(input)).toThrow('valid customer email');
    const address = group('shopify');
    address.address = { shipping_name: 'x\u0000y' };
    expect(() => shopifyOrderImportPlan(address)).toThrow('shipping address');
  });
  it('computes an exact repeated-paise sum and rejects aggregate unit overflow', () => {
    const input = group();
    input.lines = [{ row: 2, productId: '2', quantity: '10', price: '0.10' }];
    expect(offlineOrderImportPlan(input).originalTenderAmount).toBe('1.00');
    input.lines.push({ row: 3, productId: '3', quantity: '990', price: '0.10' });
    expect(() => offlineOrderImportPlan(input)).toThrow('unit or amount limit');
  });
});
