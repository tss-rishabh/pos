import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { catalogWorkbook } from '../../src/pages/catalog/workbook';
describe('offline catalog Excel export', () => {
  it('can be decoded by independent ZIP/XML readers, preserving long identifiers and formula-like literal cells', async () => {
    const blob = catalogWorkbook(
      ['ID', 'Product', 'Price'],
      [
        ['9007199254740993', '=HYPERLINK("https://invalid.test")', '10.00'],
        ['2', 'blue <cotton> & "quote"\u0000', null],
      ],
    );
    const python =
      "import sys,zipfile,io,json,xml.etree.ElementTree as E; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; n={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}; s=E.fromstring(z.read('xl/worksheets/sheet1.xml')); print(json.dumps({'names':z.namelist(),'rows':[[c.find('m:is/m:t',n).text or '' for c in r] for r in s.find('m:sheetData',n)],'formulas':len(s.findall('.//m:f',n))}))";
    const decoded: unknown = JSON.parse(
      execFileSync('python3', ['-c', python], {
        input: Buffer.from(await blob.arrayBuffer()),
        encoding: 'utf8',
      }),
    );
    expect(decoded).toMatchObject({
      rows: [
        ['ID', 'Product', 'Price'],
        ['9007199254740993', '=HYPERLINK("https://invalid.test")', '10.00'],
        ['2', 'blue <cotton> & "quote"', ''],
      ],
      formulas: 0,
    });
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});
