import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readInventoryWorkbookOptions } from '../../src/modules/inventory-workbooks/options.js';
import { safeLegacyWorkbookStream } from '../../src/modules/inventory-workbooks/legacy.js';
import { createExportSpool } from '../../src/modules/inventory-workbooks/staging.js';
import { checkWorkbookZip } from '../../src/modules/inventory-workbooks/zip-validation.js';
import {
  finishWorkbookXml,
  workbookXmlValidator,
  type WorkbookXmlState,
} from '../../src/modules/inventory-workbooks/xml-validation.js';

const directories: string[] = [];
const signal = () => new AbortController().signal;
const python =
  process.env.INVENTORY_WORKBOOK_ORACLE_PYTHON || 'tools/inventory-workbooks/.venv/bin/python';
function source(product = 'Safe shirt') {
  const raw: unknown = JSON.parse(
    execFileSync(python, ['tools/inventory-workbooks/source-oracle.py'], {
      encoding: 'utf8',
      input: JSON.stringify({
        stores: [
          {
            id: '1',
            rows: [
              {
                id: '11',
                store_name: 'Fixture',
                parent_id: '10',
                child_id: '11',
                product,
                erp_product: 'SKU',
                category: 'Shirts',
                variant: 'M',
                inventory: 3,
                gtin: '1234567890123',
              },
            ],
          },
        ],
      }),
    }),
  );
  return Buffer.from(z.object({ artifactBase64: z.string() }).parse(raw).artifactBase64, 'base64');
}
async function options() {
  const directory = await mkdtemp(join(tmpdir(), 'pos-legacy-workbook-'));
  directories.push(directory);
  return readInventoryWorkbookOptions({ INVENTORY_WORKBOOK_STAGING_DIRECTORY: directory });
}
async function contents(bytes: Buffer) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false }),
    entries = new Map<string, string>();
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory || !entry.getData) throw new Error('Missing fixture entry.');
      entries.set(entry.filename, await entry.getData(new TextWriter()));
    }
  } finally {
    await reader.close();
  }
  return entries;
}
async function archive(entries: Map<string, string>) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    zip64: false,
    useWebWorkers: false,
    useCompressionStream: true,
  });
  for (const [name, value] of entries) await writer.add(name, new TextReader(value));
  return Buffer.from(await writer.close());
}
async function consume(body: Readable) {
  const result: Buffer[] = [];
  for await (const value of body as AsyncIterable<unknown>) {
    if (!(value instanceof Uint8Array)) throw new Error('Unexpected bytes.');
    result.push(Buffer.from(value));
  }
  return Buffer.concat(result);
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe('bounded legacy XLSX acceptance', () => {
  it('accepts the actual pinned source OpenXML workbook and releases its private staging after download', async () => {
    const bytes = source(),
      config = await options();
    const spool = await createExportSpool(config, 1000000, signal()),
      writer = spool.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const sealed = await spool.seal();
    try {
      expect((await checkWorkbookZip(sealed, config, signal())).length).toBeGreaterThan(5);
      const entries = await contents(bytes),
        state: WorkbookXmlState = {
          names: new Set(entries.keys()),
          overrides: new Map(),
          relationships: new Map(),
          sheets: [],
        };
      for (const [part, xml] of entries) {
        try {
          const validator = workbookXmlValidator(part, state);
          validator.write(xml);
          validator.close();
        } catch (cause) {
          throw new Error('Rejected synthetic part ' + part, { cause });
        }
      }
      finishWorkbookXml(state);
    } finally {
      await sealed.dispose();
    }
    const file = await safeLegacyWorkbookStream(Readable.from([bytes]), config, 1000000, signal());
    expect(file.size).toBe(bytes.length);
    expect(await consume(file.body)).toEqual(bytes);
    await expect.poll(() => readdir(config.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
  });
  it('rejects source formula cells before any browser bytes can escape', async () => {
    const config = await options();
    await expect(
      safeLegacyWorkbookStream(
        Readable.from([source('=HYPERLINK("https://example.test","x")')]),
        config,
        1000000,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_WORKBOOK_UNVERIFIED' });
    expect(await readdir(config.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
  });
  it.each(['macro', 'external', 'entity', 'traversal', 'formula', 'giant-token'] as const)(
    'rejects %s payloads with bounded static diagnostics',
    async (kind) => {
      const entries = await contents(source());
      if (kind === 'macro') entries.set('xl/vbaProject.bin', 'not-an-allowed-part');
      else if (kind === 'external')
        entries.set(
          'xl/_rels/workbook.xml.rels',
          entries
            .get('xl/_rels/workbook.xml.rels')!
            .replace(
              'Target="/xl/worksheets/sheet1.xml"',
              'Target="https://example.test/sheet.xml" TargetMode="External"',
            ),
        );
      else if (kind === 'entity')
        entries.set(
          'xl/worksheets/sheet1.xml',
          '<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
            entries.get('xl/worksheets/sheet1.xml')!,
        );
      else if (kind === 'traversal') entries.set('../worksheet.xml', '<worksheet/>');
      else if (kind === 'formula')
        entries.set(
          'xl/workbook.xml',
          entries
            .get('xl/workbook.xml')!
            .replace(
              '<sheets>',
              '<definedNames><definedName name="bad">1+1</definedName></definedNames><sheets>',
            ),
        );
      else
        entries.set(
          'xl/worksheets/sheet1.xml',
          entries.get('xl/worksheets/sheet1.xml')!.replace('Safe shirt', 'A'.repeat(400000)),
        );
      const bytes = await archive(entries),
        config = await options();
      await expect(
        safeLegacyWorkbookStream(Readable.from([bytes]), config, 1000000, signal()),
      ).rejects.toMatchObject({ code: 'LEGACY_WORKBOOK_UNVERIFIED' });
      expect(await readdir(config.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
    },
  );
  it('refuses declared expansion bombs, truncated ZIP and duplicate entry names before decompression', async () => {
    const original = source(),
      config = await options();
    const bomb = Buffer.from(original),
      index = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(config.INVENTORY_WORKBOOK_LEGACY_MAX_ENTRY_BYTES + 1, index + 24);
    const duplicate = new ZipWriter(new Uint8ArrayWriter(), { zip64: false, useWebWorkers: false });
    await duplicate.add('xl/workbook.xml', new TextReader('<a/>'));
    await duplicate.add('XL/workbook.xml', new TextReader('<a/>'));
    await duplicate.add('[Content_Types].xml', new TextReader('<a/>'));
    for (const bytes of [bomb, original.subarray(0, -1), Buffer.from(await duplicate.close())])
      await expect(
        safeLegacyWorkbookStream(Readable.from([bytes]), config, 1000000, signal()),
      ).rejects.toMatchObject({ code: 'LEGACY_WORKBOOK_UNVERIFIED' });
    expect(await readdir(config.INVENTORY_WORKBOOK_STAGING_DIRECTORY)).toEqual([]);
  });
});
