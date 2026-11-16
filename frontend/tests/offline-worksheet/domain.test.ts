import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addWorksheetLine,
  createWorksheet,
  removeWorksheetLine,
  validateWorksheet,
  worksheetAmounts,
  worksheetCsv,
  worksheetCsvHeaders,
} from '../../src/pages/offline-worksheet/domain';

const now = Date.parse('2026-06-15T06:00:00.000Z');
const item = (productId = '12', quantity = '2', unitPrice = '25.49') => ({
  productId,
  name: 'Synthetic shirt',
  quantity,
  unitPrice,
});
function sourceCsv(
  lines: { productId: string; name: string; quantity: number; unitPrice: string }[],
  sourcePath: string | null = fileURLToPath(
    new URL(
      '../../../../backend-pos-web/core/templates/offline_billing/biller.html',
      import.meta.url,
    ),
  ),
) {
  const fixture = z
    .object({
      sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
      templateSha256: z.literal('127a5eac3a416bd214462ae3827493fecce15a78695fb11049f00b8e2efd9168'),
      functionsSha256: z.literal(
        '9d67d9699235ed5f6c0e6a6c20dd3d609e64d6fa08c60c68894fcb0130b28b52',
      ),
      javascript: z.string(),
    })
    .strict()
    .parse(
      JSON.parse(readFileSync(new URL('./source-oracle.json', import.meta.url), 'utf8')) as unknown,
    );
  expect(createHash('sha256').update(fixture.javascript).digest('hex')).toBe(
    fixture.functionsSha256,
  );
  let script = fixture.javascript;
  if (sourcePath !== null && existsSync(sourcePath)) {
    const text = readFileSync(sourcePath, 'utf8');
    expect(createHash('sha256').update(text).digest('hex')).toBe(fixture.templateSha256);
    script = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1]!)
      .find((value) => value.includes('function exportTableToCSV'))!;
  }
  const source = ts.createSourceFile(
    'original-worksheet.js',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      ['exportTableToCSV', 'getTotalAmount', 'setOrderID'].includes(node.name?.text ?? ''),
  );
  expect(functions).toHaveLength(3);
  const javascript = functions.map((node) => node.getText(source)).join('\n');
  expect(javascript).toBe(fixture.javascript);
  let exported = '';
  runInNewContext(
    javascript.replaceAll('{{ store.id }}', '1') + '\nexportTableToCSV("invoice.csv");',
    {
      Date: class extends Date {
        static override now() {
          return now;
        }
      },
      document: {
        querySelectorAll: () => [],
        getElementById: (id: string) => ({
          value: id === 'user-name' ? 'Synthetic customer' : 'synthetic@example.test',
        }),
      },
      itemsList: lines.map((line) => [line.productId, line.name, line.unitPrice, line.quantity]),
      totalAmount: lines.reduce((sum, line) => sum + Number(line.unitPrice) * line.quantity, 0),
      orderID: null,
      downloadCSV: (csv: string, filename: string) => {
        expect(filename).toBe('invoice.csv');
        exported = csv;
      },
    },
  );
  return exported.split('\n').map((row) => row.split(','));
}

describe('separate offline invoice worksheet', () => {
  it('replays the exact extracted source functions in standalone desktop CI', () => {
    const sheet = addWorksheetLine(createWorksheet('1', now), item());
    expect(sourceCsv(sheet.lines, null)).toEqual(sourceCsv(sheet.lines));
  });
  it('retains the original fourteen-column metadata and per-row quantity/price semantics', () => {
    const sheet = addWorksheetLine(
      addWorksheetLine(createWorksheet('1', now), item()),
      item('13', '1', '10.01'),
    );
    sheet.customerName = 'Synthetic customer';
    sheet.customerEmail = 'synthetic@example.test';
    const original = sourceCsv(sheet.lines),
      rewritten = worksheetCsv(sheet)
        .split('\n')
        .map((row) => row.split(','));
    expect(rewritten[0]).toEqual(worksheetCsvHeaders);
    expect(original[0]).toEqual(rewritten[0]);
    for (let index = 1; index < rewritten.length; index++) {
      const before = [...original[index]!];
      while (before.length < 14) before.push('');
      const after = rewritten[index]!;
      for (let column = 0; column < 14; column++)
        if ([7, 8, 9].includes(column) && before[column] !== '')
          expect(Math.round(Number(after[column]) * 100)).toBe(
            Math.round(Number(before[column]) * 100),
          );
        else expect(after[column]).toBe(before[column]);
    }
    expect(worksheetAmounts(sheet)).toEqual({ total: '60.99', rounding: '0.99', rounded: '60.00' });
  });
  it('keeps duplicate products as separate manual rows and removes only the chosen row', () => {
    const sheet = addWorksheetLine(
      addWorksheetLine(createWorksheet('1', now), item()),
      item('12', '1', '10.01'),
    );
    const remaining = removeWorksheetLine(sheet, sheet.lines[0]!.id);
    expect(sheet.lines).toHaveLength(2);
    expect(remaining.lines).toHaveLength(1);
    expect(worksheetAmounts(remaining).total).toBe('10.01');
    expect(worksheetCsv(remaining).split('\n')[1]?.split(',')[0]).toBe(sheet.serialNo);
  });
  it('preserves full-width identifiers and exact paise, including a zero-priced worksheet line', () => {
    let sheet = createWorksheet('9223372036854775807', now);
    sheet = addWorksheetLine(sheet, item('9007199254740993', '3', '0.01'));
    sheet = addWorksheetLine(sheet, item('9007199254740994', '1', '0'));
    expect(worksheetAmounts(sheet).total).toBe('0.03');
    expect(worksheetCsv(sheet)).toContain('9007199254740993,3,0.01,0.03');
    expect(worksheetCsv(sheet)).toContain('9223372036854775807');
  });
  it.each([
    item('invalid'),
    item('9223372036854775808'),
    item('12', '1.5'),
    item('12', '0'),
    item('12', '1000'),
    item('12', '1', 'NaN'),
    item('12', '1', '1e3'),
    item('12', '1', '0.001'),
    item('12', '1', '-1'),
  ])('rejects invalid lines before changing the worksheet', (input) => {
    const sheet = createWorksheet('1', now);
    expect(() => addWorksheetLine(sheet, input)).toThrow();
    expect(sheet.lines).toEqual([]);
  });
  it('quotes customer punctuation and refuses spreadsheet formulas or invalid contact data', () => {
    const sheet = addWorksheetLine(createWorksheet('1', now), item());
    sheet.customerName = 'Synthetic, "label"';
    expect(worksheetCsv(sheet)).toContain('"Synthetic, ""label"""');
    sheet.customerName = '=IMPORTXML("unsafe")';
    expect(() => worksheetCsv(sheet)).toThrow('unsafe');
    sheet.customerName = 'Safe label';
    sheet.customerEmail = 'not-an-email';
    expect(() => validateWorksheet(sheet)).toThrow('valid customer');
    expect(() => worksheetCsv(createWorksheet('1', now))).toThrow('Add at least');
  });
});
