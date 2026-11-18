import { describe, expect, it } from 'vitest';
import {
  groupOfflineOrderCsv,
  groupShopifyOrderCsv,
  offlineOrderColumns,
  shopifyOrderColumns,
  type LegacyImportGroup,
} from '../../src/modules/legacy-order-imports/csv.js';
import { goldenSpawnResult } from '../golden/load.js';

function csv(columns: readonly string[], rows: Readonly<Record<string, string>>[]) {
  return [columns, ...rows.map((row) => columns.map((key) => row[key] ?? ''))]
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
}
function offline(values: Record<string, string> = {}) {
  return {
    SerialNo: 'A',
    StoreId: '1',
    Email: 'buyer@example.test',
    UserName: 'Ignored fixture name',
    IsExclusive: '1',
    ProductId: '9007199254740993',
    ProductQty: '1',
    ProductPrice: '25.49',
    PaymentMode: 'cash',
    OrderDate: '2026-06-15 12:00:00',
    OrderPlacedSms: '0',
    OrderMessage: 'Fixture message',
    ...values,
  };
}
function shopify(values: Record<string, string> = {}) {
  return {
    Name: '#1001',
    Email: 'buyer@example.test',
    'Financial Status': 'paid',
    Currency: 'INR',
    Subtotal: '100',
    Shipping: '0',
    Taxes: '18',
    Total: '118',
    'Created at': '2026-06-15 06:30:00 +0000',
    'Lineitem quantity': '1',
    'Lineitem price': '100',
    'Lineitem sku': '9007199254740993',
    'Shipping Name': 'Fixture recipient',
    'Shipping City': 'Fixture city',
    'Tax 1 Name': 'GST 18%',
    'Tax 1 Value': '18',
    ...values,
  };
}
function source(kind: 'offline' | 'shopify', text: string) {
  const result = goldenSpawnResult(
    'legacy-order-imports',
    'csv',
    JSON.stringify({ kind, csv: text, storeId: '1' }),
  );
  expect(result.status, 'The pinned in-memory source grouping oracle must execute.').toBe(0);
  return JSON.parse(result.stdout) as { groups: unknown[]; failureCount: number };
}
function originalShape(groups: LegacyImportGroup[]) {
  return groups.map((group) => ({
    order_details: [group.details],
    line_item: group.lines.map((line) => ({
      product_id: line.productId,
      product_qty: line.quantity,
      product_price: line.price,
    })),
    ...(group.address ? { address: [group.address] } : {}),
  }));
}
describe('pinned dormant order-import CSV grouping', () => {
  it('matches original offline boundaries, including repeated nonempty serials and continuation rows', () => {
    const text = csv(offlineOrderColumns, [
      offline(),
      offline({ SerialNo: '', ProductId: '2', ProductQty: '3' }),
      offline({ SerialNo: 'A', StoreId: '2' }),
    ]);
    const groups = groupOfflineOrderCsv(text),
      legacy = source('offline', text);
    expect(originalShape(groups)).toEqual(legacy.groups);
    expect(legacy.failureCount).toBe(0);
    expect(groups.map((group) => [group.sequence, group.firstRow, group.lines.length])).toEqual([
      [1, 2, 2],
      [2, 4, 1],
    ]);
    expect(groups[0]?.lines[0]?.productId).toBe('9007199254740993');
  });
  it('matches source quoted newlines, commas, escaped quotes and Unicode without exposing input in diagnostics', () => {
    const text = csv(offlineOrderColumns, [
      offline({ OrderMessage: 'Two lines\nwith a "quote", and café', UserName: 'Ignored Ω' }),
    ]);
    expect(originalShape(groupOfflineOrderCsv(text))).toEqual(source('offline', text).groups);
  });
  it('ignores additional export columns as the source does', () => {
    const text = csv(
      [...offlineOrderColumns, 'Additional export column'],
      [offline({ 'Additional export column': 'ignored' })],
    );
    expect(originalShape(groupOfflineOrderCsv(text))).toEqual(source('offline', text).groups);
  });
  it('matches adjacent Shopify Name grouping and source first-row address/metadata', () => {
    const text = csv(shopifyOrderColumns, [
      shopify(),
      shopify({ 'Lineitem sku': '2', 'Shipping City': 'Ignored continuation city' }),
      shopify({ Name: '#1002' }),
    ]);
    expect(originalShape(groupShopifyOrderCsv(text, '1'))).toEqual(source('shopify', text).groups);
    expect(groupShopifyOrderCsv(text, '1').map((group) => group.lines.length)).toEqual([2, 1]);
  });
  it('preserves the original Shopify blank-Name transition rather than silently merging nonadjacent references', () => {
    const text = csv(shopifyOrderColumns, [shopify(), shopify({ Name: '' }), shopify()]);
    const groups = groupShopifyOrderCsv(text, '1');
    expect(originalShape(groups)).toEqual(source('shopify', text).groups);
    expect(groups.map((group) => group.reference)).toEqual(['#1001', '#1001']);
  });
  it('accepts a UTF-8 BOM as an explicit input compatibility correction', () => {
    const text = csv(offlineOrderColumns, [offline()]);
    expect(groupOfflineOrderCsv('\ufeff' + text)).toEqual(groupOfflineOrderCsv(text));
  });
  it.each(['offline', 'shopify'] as const)(
    'rejects an orphan %s line before any execution is possible',
    (kind) => {
      const text =
        kind === 'offline'
          ? csv(offlineOrderColumns, [offline({ SerialNo: '' })])
          : csv(shopifyOrderColumns, [shopify({ Name: '' })]);
      expect(() =>
        kind === 'offline' ? groupOfflineOrderCsv(text) : groupShopifyOrderCsv(text, '1'),
      ).toThrow('must begin');
    },
  );
  it('rejects duplicate/missing headers and malformed records with fixed privacy-safe messages', () => {
    for (const text of [
      csv([...offlineOrderColumns, 'Email'], [offline()]),
      csv(offlineOrderColumns.slice(1), [offline()]),
      csv(offlineOrderColumns, [offline()]) + '\n"private@example.test',
    ]) {
      try {
        groupOfflineOrderCsv(text);
        throw new Error('Expected invalid CSV');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain('private@example.test');
        expect((error as Error).message).not.toBe('Expected invalid CSV');
      }
    }
  });
  it('rejects files and row streams over their bounds without silently keeping only a prefix', () => {
    expect(() => groupOfflineOrderCsv('x'.repeat(5 * 1024 * 1024 + 1))).toThrow('file-size limit');
    const row = offline({ SerialNo: 'A', Email: '', UserName: '', OrderMessage: '' });
    const text = csv(
      offlineOrderColumns,
      Array.from({ length: 50001 }, () => row),
    );
    expect(() => groupOfflineOrderCsv(text)).toThrow('row limit');
  });
});
