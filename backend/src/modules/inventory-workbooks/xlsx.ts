import { ZipWriter, TextReader } from '@zip.js/zip.js';
import { AppError } from '../../domain/errors.js';
import type { ExportArtifact } from '../operational-reports/export-artifact.js';
import type { InventoryWorkbookOptions } from './options.js';
import {
  inventoryWorkbookHeaders,
  type InventoryWorkbookRow,
  type InventoryWorkbookStore,
  type InventoryWorkbookPage,
} from './contracts.js';
import { createExportSpool } from './staging.js';

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const worksheetStart = `${xmlDeclaration}<worksheet xmlns="${spreadsheetNamespace}"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><sheetData>`;
const worksheetEnd =
  '</sheetData><pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>';
const styles = `${xmlDeclaration}<styleSheet xmlns="${spreadsheetNamespace}"><fonts count="1"><font><name val="Calibri"/><family val="2"/><color theme="1"/><sz val="11"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
function escaped(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
/** Source openpyxl truncates to32767 Unicode characters, then rejects illegal XML controls. */
export function workbookLiteral(value: string) {
  const text = Array.from(value).slice(0, 32767).join('');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(text))
    throw new AppError(
      422,
      'WORKBOOK_CELL_INVALID',
      'A report value contains unsupported spreadsheet characters.',
    );
  return escaped(text);
}
function cells(values: readonly (string | number | null)[], ordinal: number) {
  return `<row r="${ordinal}">${values
    .map((value, index) => {
      const reference = `${String.fromCharCode(65 + index)}${ordinal}`;
      if (value === null) return '';
      if (typeof value === 'number') return `<c r="${reference}" t="n"><v>${value}</v></c>`;
      const literal = workbookLiteral(value);
      return literal
        ? `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${literal}</t></is></c>`
        : `<c r="${reference}" t="inlineStr"></c>`;
    })
    .join('')}</row>`;
}
function rowValues(row: InventoryWorkbookRow) {
  return [
    row.store_name,
    row.parent_id,
    row.child_id,
    row.product,
    row.erp_product,
    row.variant,
    row.category,
    row.inventory,
    row.gtin,
  ];
}
function readable(
  values: AsyncIterable<string>,
  signal: AbortSignal,
  count: (bytes: number) => void,
) {
  const iterator = values[Symbol.asyncIterator](),
    encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      signal.throwIfAborted();
      const next = await iterator.next();
      if (next.done) controller.close();
      else {
        const bytes = encoder.encode(next.value);
        count(bytes.length);
        controller.enqueue(bytes);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
export async function writeInventoryWorkbook(
  stores: AsyncIterable<InventoryWorkbookStore>,
  options: InventoryWorkbookOptions,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ExportArtifact> {
  const spool = await createExportSpool(options, maxBytes, signal);
  const sheetNames: string[] = [];
  let rowCount = 0,
    xmlBytes = 0;
  try {
    const zip = new ZipWriter(spool.writable, {
      signal,
      useWebWorkers: false,
      useCompressionStream: true,
      bufferedWrite: false,
      zip64: false,
      level: 6,
    });
    for await (const store of stores) {
      signal.throwIfAborted();
      const pages = store.pages[Symbol.asyncIterator](),
        first = await pages.next();
      if (first.done || first.value.candidateIds.length === 0) {
        await pages.return?.();
        continue;
      }
      const base = `Store_${store.storeId}`,
        title = sheetNames.includes(base) ? `${base}_${sheetNames.length}` : base;
      if (title.length > 31 || sheetNames.length >= 500)
        throw new AppError(422, 'EXPORT_TOO_LARGE', 'Select fewer stores for this workbook.');
      sheetNames.push(title);
      let sheetRows = 0,
        sheetBytes = 0;
      async function* worksheet() {
        yield worksheetStart;
        let page: InventoryWorkbookPage | undefined = first.done ? undefined : first.value;
        while (page) {
          signal.throwIfAborted();
          for (const row of page.rows) {
            if (sheetRows === 0) yield cells(inventoryWorkbookHeaders, 1);
            if (++sheetRows > 1048575)
              throw new AppError(
                422,
                'EXPORT_TOO_LARGE',
                'A store exceeds the Excel worksheet row limit.',
              );
            yield cells(rowValues(row), sheetRows + 1);
            rowCount++;
          }
          const next = await pages.next();
          page = next.done ? undefined : next.value;
        }
        yield worksheetEnd;
      }
      try {
        await zip.add(
          `xl/worksheets/sheet${sheetNames.length}.xml`,
          readable(worksheet(), signal, (bytes) => {
            sheetBytes += bytes;
            xmlBytes += bytes;
            if (
              sheetBytes > options.INVENTORY_WORKBOOK_MAX_SHEET_XML_BYTES ||
              xmlBytes > options.INVENTORY_WORKBOOK_MAX_XML_BYTES
            )
              throw new AppError(
                422,
                'EXPORT_TOO_LARGE',
                'The workbook exceeds the allowed expanded size. Select fewer stores.',
              );
          }),
        );
      } finally {
        await pages.return?.();
      }
    }
    if (!sheetNames.length) {
      sheetNames.push('NoData');
      await zip.add('xl/worksheets/sheet1.xml', new TextReader(worksheetStart + worksheetEnd));
    }
    const contentTypes = `${xmlDeclaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetNames.map((_name, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
    const workbook = `${xmlDeclaration}<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetNames.map((name, index) => `<sheet name="${escaped(name)}" sheetId="${index + 1}" state="visible" r:id="rId${index + 1}"/>`).join('')}</sheets><calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>`;
    const relationships = `${xmlDeclaration}<Relationships xmlns="${packageRelationshipNamespace}">${sheetNames.map((_name, index) => `<Relationship Type="${relationshipNamespace}/worksheet" Target="worksheets/sheet${index + 1}.xml" Id="rId${index + 1}"/>`).join('')}<Relationship Type="${relationshipNamespace}/styles" Target="styles.xml" Id="rId${sheetNames.length + 1}"/></Relationships>`;
    await zip.add('[Content_Types].xml', new TextReader(contentTypes));
    await zip.add(
      '_rels/.rels',
      new TextReader(
        `${xmlDeclaration}<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Type="${relationshipNamespace}/officeDocument" Target="xl/workbook.xml" Id="rId1"/></Relationships>`,
      ),
    );
    await zip.add('xl/workbook.xml', new TextReader(workbook));
    await zip.add('xl/_rels/workbook.xml.rels', new TextReader(relationships));
    await zip.add('xl/styles.xml', new TextReader(styles));
    await zip.close();
    return { format: 'XLSX', rowCount, file: await spool.seal() };
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}
