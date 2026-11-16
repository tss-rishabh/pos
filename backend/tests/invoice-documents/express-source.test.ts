import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { sanitizeInvoiceHtml } from '../../src/modules/checkout/invoices.js';
const row = z.object({
  name: z.string(),
  sameHtml: z.boolean(),
  sourceHash: z.string(),
  candidateHash: z.string(),
  sourceQuantity: z.number(),
  selectedQuantity: z.number(),
  sourcePrice: z.number(),
  selectedPrice: z.number(),
  sourcePoints: z.number(),
  selectedPoints: z.number(),
  sourceGiftRows: z.number(),
  selectedGiftRows: z.number(),
  selectedGstin: z.string(),
  selectedStoreDiscount: z.number(),
  additional: z.record(z.string(), z.unknown()),
  html: z.string(),
});
it('executes original shop tax math/template and proves selection before grouping plus scoped gift/points/store corrections', async () => {
  const raw = execFileSync(
    'uv',
    [
      'run',
      '--frozen',
      '--project',
      resolve('compatibility/upstream/invoice-security/runtime'),
      'python',
      resolve('tools/invoice-documents/express-oracle.py'),
    ],
    {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 512 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const result = z
    .object({
      sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
      scope: z.string(),
      cases: z.array(row).length(3),
    })
    .parse(JSON.parse(raw) as unknown);
  for (const vector of result.cases.slice(0, 2)) {
    expect(vector.sameHtml).toBe(true);
    expect(vector.candidateHash).toBe(vector.sourceHash);
  }
  const corrected = result.cases[2]!;
  expect(corrected).toMatchObject({
    sameHtml: false,
    sourceQuantity: 3,
    selectedQuantity: 1,
    sourcePrice: 150,
    selectedPrice: 50,
    sourcePoints: 100,
    selectedPoints: 1,
    sourceGiftRows: 1,
    selectedGiftRows: 0,
    selectedGstin: 'GSTIN-STORE-1',
    selectedStoreDiscount: 5,
  });
  expect(corrected.additional).toMatchObject({
    total_items: 1,
    cart_total: 50,
    total_taxable: 47.62,
    cgst: 1.19,
    sgst: 1.19,
    invoice_total: 50,
  });
  const html = sanitizeInvoiceHtml(corrected.html);
  for (const field of ['GSTIN-STORE-1', 'HSN', '6109', 'CGST', 'SGST', 'FIXTURE1'])
    expect(html).toContain(field);
  expect(html).not.toContain('GSTIN-STORE-2');
  expect(html).not.toContain('FOREIGN2');
  const cases = result.cases.map(({ html: _html, ...value }) => value),
    directory = resolve('parity/evidence/invoice-documents');
  await mkdir(directory, { recursive: true });
  await writeFile(
    directory + '/express-source.json.tmp',
    JSON.stringify({ ...result, cases }, null, 2) + '\n',
  );
  await rename(directory + '/express-source.json.tmp', directory + '/express-source.json');
}, 30000);
it('executes the active source SDD handler and preserves its zero shipment flag while removing query credentials', () => {
  const raw = execFileSync('python3', [resolve('tools/invoice-documents/sdd-oracle.py')], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  expect(
    z
      .object({
        sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
        orderId: z.literal('12345'),
        isSddShipment: z.literal('0'),
        legacyCredentialInQuery: z.literal(true),
        rewriteCredentialTransport: z.literal('private-header-only'),
        template: z.literal('order/invoice.html'),
        isStore: z.literal(false),
        requests: z.literal(1),
      })
      .parse(JSON.parse(raw) as unknown),
  ).toBeTruthy();
});
