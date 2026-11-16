import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  inventoryWorkbookRowSchema,
  type InventoryWorkbookRow,
  type InventoryWorkbookStore,
} from '../../src/modules/inventory-workbooks/contracts.js';
import { readInventoryWorkbookOptions } from '../../src/modules/inventory-workbooks/options.js';
import { writeInventoryWorkbook } from '../../src/modules/inventory-workbooks/xlsx.js';
import type { ExportArtifact } from '../../src/modules/operational-reports/export-artifact.js';

const sourcePython =
  process.env.INVENTORY_WORKBOOK_ORACLE_PYTHON || 'tools/inventory-workbooks/.venv/bin/python';
const directories: string[] = [];
const sheetSchema = z.object({
  name: z.string(),
  rowCount: z.number(),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  firstRows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  lastRow: z.array(z.union([z.string(), z.number(), z.null()])).nullable(),
  formulaCount: z.number(),
});
const oracleSchema = z.object({
  artifactBase64: z.string().nullable(),
  sheets: z.array(sheetSchema),
  chunkArguments: z.array(z.object({ storeId: z.string(), ids: z.number(), ordinal: z.number() })),
  declaredRows: z.number().nullable(),
  declaredStatus: z.string().nullable(),
  paths: z.array(z.string()),
});
function oracle(input: unknown) {
  return JSON.parse(
    execFileSync(sourcePython, ['tools/inventory-workbooks/source-oracle.py'], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as unknown;
}
function row(
  id: string,
  store = 'Fixture',
  overrides: Partial<InventoryWorkbookRow> = {},
): InventoryWorkbookRow {
  return inventoryWorkbookRowSchema.parse({
    id,
    store_name: store,
    parent_id: '100',
    child_id: id,
    product: 'Fixture shirt',
    erp_product: 'SKU',
    variant: 'M',
    category: 'T-Shirts',
    inventory: 7,
    gtin: '1234567890123',
    ...overrides,
  });
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'pos-workbook-test-'));
  directories.push(directory);
  return readInventoryWorkbookOptions({ INVENTORY_WORKBOOK_STAGING_DIRECTORY: directory });
}
async function bytes(artifact: ExportArtifact) {
  if ('bytes' in artifact) return artifact.bytes;
  const source = await artifact.file.open(),
    values: Buffer[] = [];
  for await (const value of source as AsyncIterable<unknown>) {
    if (!(value instanceof Uint8Array)) throw new Error('Unexpected artifact chunk.');
    values.push(Buffer.from(value));
  }
  return Buffer.concat(values);
}
async function inspect(artifact: ExportArtifact) {
  return z
    .object({ sheets: z.array(sheetSchema) })
    .parse(
      oracle({ action: 'inspect', artifactBase64: (await bytes(artifact)).toString('base64') }),
    ).sheets;
}
async function* stores(
  input: { id: string; rows: InventoryWorkbookRow[]; candidateIds?: string[] }[],
): AsyncIterable<InventoryWorkbookStore> {
  for (const store of input) {
    async function* pages() {
      const ids = store.candidateIds || store.rows.map((item) => item.id);
      for (let offset = 0; offset < ids.length; offset += 500) {
        const selected = ids.slice(offset, offset + 500),
          set = new Set(selected);
        yield { candidateIds: selected, rows: store.rows.filter((item) => set.has(item.id)) };
      }
    }
    yield { storeId: store.id, pages: pages() };
  }
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
describe('streamed XLSX against the literal source workbook pipeline', () => {
  it('preserves nine headers, requested store order, nulls and empty filtered stores through actual source merges', async () => {
    const input = [
      {
        id: '2',
        rows: [
          row('201', 'Second', {
            erp_product: null,
            variant: null,
            category: null,
            gtin: null,
            inventory: -3,
          }),
        ],
      },
      { id: '1', rows: [row('101')] },
      { id: '3', rows: [] },
      { id: '4', rows: [], candidateIds: ['401'] },
    ];
    const original = oracleSchema.parse(oracle({ stores: input, countOverride: 999999 })),
      options = await setup();
    const artifact = await writeInventoryWorkbook(
      stores(input),
      options,
      10 * 1024 * 1024,
      new AbortController().signal,
    );
    try {
      expect(await inspect(artifact)).toEqual(original.sheets);
      expect(original.sheets.map((sheet) => sheet.name)).toEqual(['Store_2', 'Store_1', 'Store_4']);
      expect(artifact.rowCount).toBe(2);
      expect(original.declaredRows).toBe(0);
    } finally {
      if ('file' in artifact) await artifact.file.dispose();
    }
  });
  it('pins50000-ID chunk arguments and avoids duplicate final headers across the source boundary', async () => {
    const ids = Array.from({ length: 50001 }, (_value, index) => String(index + 1)),
      input = [{ id: '1', rows: [row('50000'), row('50001')], candidateIds: ids }];
    const original = oracleSchema.parse(oracle({ stores: input })),
      artifact = await writeInventoryWorkbook(
        stores(input),
        await setup(),
        10 * 1024 * 1024,
        new AbortController().signal,
      );
    try {
      expect(original.chunkArguments).toEqual([
        { storeId: '1', ids: 50000, ordinal: 50000 },
        { storeId: '1', ids: 1, ordinal: 100000 },
      ]);
      expect(await inspect(artifact)).toEqual(original.sheets);
      expect(original.paths).toContain('/tmp/temp_exports/store_1_50000.xlsx');
      expect(original.paths).toContain('/tmp/temp_exports/store_1_100000.xlsx');
    } finally {
      if ('file' in artifact) await artifact.file.dispose();
    }
  });
  it('preserves full-width IDs/GTIN and literal formula-shaped text as explicit source safety corrections', async () => {
    const id = '9007199254740993',
      input = [
        {
          id: '1',
          rows: [
            row(id, 'Fixture', {
              parent_id: id,
              gtin: '9223372036854775807',
              product: '=HYPERLINK("https://example.test","x")',
              variant: 'é & <M>',
              erp_product: '+SUM(1,2)',
            }),
          ],
        },
      ];
    const artifact = await writeInventoryWorkbook(
      stores(input),
      await setup(),
      10 * 1024 * 1024,
      new AbortController().signal,
    );
    try {
      const inspected = await inspect(artifact),
        original = oracleSchema.parse(oracle({ stores: input }));
      expect(original.sheets[0]?.formulaCount).toBe(1);
      expect(inspected[0]?.formulaCount).toBe(0);
      expect(original.sheets[0]?.rows[1]?.[1]).not.toBe(id);
      expect(inspected[0]?.rows[1]).toEqual([
        'Fixture',
        id,
        id,
        '=HYPERLINK("https://example.test","x")',
        '+SUM(1,2)',
        'é & <M>',
        'T-Shirts',
        7,
        '9223372036854775807',
      ]);
    } finally {
      if ('file' in artifact) await artifact.file.dispose();
    }
  });
  it('creates a completed NoData workbook instead of leaving an empty source master stuck', async () => {
    const input = [{ id: '1', rows: [] }],
      original = oracleSchema.parse(oracle({ stores: input }));
    expect(original.artifactBase64).toBeNull();
    expect(original.declaredStatus).toBeNull();
    const artifact = await writeInventoryWorkbook(
      stores(input),
      await setup(),
      10 * 1024 * 1024,
      new AbortController().signal,
    );
    try {
      expect(await inspect(artifact)).toMatchObject([{ name: 'NoData', rowCount: 0 }]);
      expect(artifact.rowCount).toBe(0);
    } finally {
      if ('file' in artifact) await artifact.file.dispose();
    }
  });
  it('cleans private output on invalid XML cells, compressed file overflow and cancellation', async () => {
    const options = await setup(),
      signal = new AbortController().signal;
    await expect(
      writeInventoryWorkbook(
        stores([{ id: '1', rows: [row('1', 'Fixture', { variant: 'invalid\u0000text' })] }]),
        options,
        10 * 1024 * 1024,
        signal,
      ),
    ).rejects.toMatchObject({ code: 'WORKBOOK_CELL_INVALID' });
    expect(await readdir(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
    await expect(
      writeInventoryWorkbook(stores([{ id: '1', rows: [row('1')] }]), options, 100, signal),
    ).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(await readdir(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeInventoryWorkbook(
        stores([{ id: '1', rows: [row('1')] }]),
        options,
        100000,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(await readdir(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
  });
  it('uses unique private artifacts for simultaneous same-store builds and truncates source TEXT consistently', async () => {
    const options = await setup(),
      input = [{ id: '1', rows: [row('1', 'Fixture', { variant: 'é'.repeat(40000) })] }],
      artifacts = await Promise.all(
        [1, 2].map(() =>
          writeInventoryWorkbook(
            stores(input),
            options,
            10 * 1024 * 1024,
            new AbortController().signal,
          ),
        ),
      );
    try {
      expect(await readdir(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toHaveLength(2);
      const outputs = await Promise.all(artifacts.map(inspect));
      expect(outputs[0]).toEqual(outputs[1]);
      expect(String(outputs[0]?.[0]?.rows[1]?.[5])).toHaveLength(32767);
    } finally {
      for (const artifact of artifacts) if ('file' in artifact) await artifact.file.dispose();
    }
  });
});
