import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { sanitizeInvoiceHtml } from '../../src/modules/checkout/invoices.js';
import { goldenStdout } from '../golden/load.js';
const numeric = z.record(z.string(), z.unknown());
it('executes8 pinned original online grouping/calculation/template cases without replacing tax arithmetic', async () => {
  const result = z
    .object({
      sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
      controllerSha256: z.string(),
      templateSha256: z.record(z.string(), z.string()),
      scope: z.string(),
      cases: z.array(
        z.object({
          name: z.string(),
          template: z.string(),
          calculation: z.number(),
          additional: numeric,
          lines: z.array(numeric),
          html: z.string(),
          htmlSha256: z.string(),
          orderCount: z.number().int().nonnegative(),
          candidateHtmlSha256: z.string(),
          candidateMysqlHistoryReads: z.literal(0),
          readOnlySelectCount: z.number(),
        }),
      ),
      issuerContexts: z
        .array(
          z.object({
            template: z.string(),
            contextStoreIds: z.array(z.string()),
            htmlSha256: z.array(z.string()),
            sourceIssuerRetained: z.literal(true),
          }),
        )
        .length(2),
      splitSelectionHazard: z.object({
        requestedHpIds: z.array(z.number()),
        sourceQuantity: z.number(),
        sourcePrice: z.number(),
        selectedRawQuantity: z.number(),
        selectedRawPrice: z.number(),
      }),
    })
    .parse(JSON.parse(goldenStdout('invoice-documents', 'source')) as unknown);
  expect(result.cases).toHaveLength(8);
  for (const proof of result.issuerContexts) {
    expect(proof.contextStoreIds).toEqual(['1', '2']);
    expect(proof.htmlSha256).toHaveLength(2);
    expect(proof.htmlSha256[0]).toBe(proof.htmlSha256[1]);
  }
  const byName = new Map(result.cases.map((value) => [value.name, value]));
  expect(byName.get('old-maharashtra')!.additional).toMatchObject({
    total_taxable: 95,
    cgst: 2.38,
    sgst: 2.38,
    igst: 0,
    rounding_off: -0.75,
  });
  expect(byName.get('old-interstate')!.additional).toMatchObject({
    total_taxable: 95,
    cgst: 0,
    sgst: 0,
    igst: 4.75,
  });
  expect(byName.get('new-maharashtra')!.additional).toMatchObject({
    total_taxable: 95.24,
    cgst: 2.38,
    sgst: 2.38,
    igst: 0,
    invoice_total: 122.5,
  });
  expect(byName.get('new-interstate')!.additional).toMatchObject({
    total_taxable: 95.24,
    cgst: 0,
    sgst: 0,
    igst: 4.76,
    invoice_total: 122.5,
  });
  expect(byName.get('new-duplicate-unit-rows')!.lines).toHaveLength(1);
  expect(byName.get('new-duplicate-unit-rows')!.lines[0]).toMatchObject({
    qty: 2,
    price: 210,
    row_ids: [101, 102],
  });
  expect(byName.get('new-distinct-customization')!.lines).toHaveLength(2);
  expect(byName.get('new-hidden-freebie')!.lines).toHaveLength(1);
  expect(byName.get('unknown-calculation-source-fallback')!.orderCount).toBe(0);
  const evidence = result.cases.map((value) => {
    expect(value.template).toBe(
      value.calculation === 2 ? 'Invoicer/old-index.html' : 'Invoicer/new-index.html',
    );
    expect(value.readOnlySelectCount).toBeGreaterThan(5);
    expect(value.candidateHtmlSha256).toBe(value.htmlSha256);
    const sanitized = sanitizeInvoiceHtml(value.html);
    for (const field of [
      'Tax Invoice',
      'HSN',
      '6109',
      'GSTIN Number: 27AAECT9591L1ZI',
      'PAN: AAECT9591L',
      'CIN: U52100MH2014PTC253583',
      'CGST',
      'SGST',
      'IGST',
      'Authorised Signatory',
    ])
      expect(sanitized).toContain(field);
    expect(sanitized).toContain('data:image/png;base64,');
    expect(sanitized).not.toContain('src="https:');
    return {
      name: value.name,
      template: value.template,
      additional: value.additional,
      lineCount: value.lines.length,
      quantity: value.lines.reduce((sum, row) => sum + Number(row.qty), 0),
      htmlSha256: value.htmlSha256,
      orderCount: value.orderCount,
      candidateHtmlSha256: value.candidateHtmlSha256,
      candidateMysqlHistoryReads: value.candidateMysqlHistoryReads,
      sanitizedSha256: createHash('sha256').update(sanitized).digest('hex'),
    };
  });
  expect(result.splitSelectionHazard).toEqual({
    requestedHpIds: [201],
    sourceQuantity: 3,
    sourcePrice: 150,
    selectedRawQuantity: 1,
    selectedRawPrice: 50,
  });
  const directory = resolve('parity/evidence/invoice-documents');
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, 'global-source-oracle.json.tmp');
  await writeFile(temporary, JSON.stringify({ ...result, cases: evidence }, null, 2) + '\n');
  await rename(temporary, resolve(directory, 'global-source-oracle.json'));
}, 30000);

it('executes the private online wrapper/credential/stamp and additive startup artifact checks', () => {
  const output = execFileSync(
    'uv',
    [
      'run',
      '--frozen',
      '--project',
      resolve('compatibility/upstream/invoice-security/runtime'),
      'python',
      '-m',
      'unittest',
      'discover',
      '-s',
      resolve('compatibility/upstream/invoice-documents'),
      '-p',
      'test_documents.py',
    ],
    {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 128 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONDONTWRITEBYTECODE: '1',
        UV_CACHE_DIR: process.env.UV_CACHE_DIR,
        UV_OFFLINE: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  expect(output).toBe('');
}, 30000);
