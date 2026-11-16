/** Small standards-compliant XLSX writer. Every source value is an inline string, never a formula. */
const encoder = new TextEncoder();
const xml = (value: unknown) =>
  String(value ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function columnName(index: number) {
  let value = '';
  for (let next = index + 1; next; next = Math.floor((next - 1) / 26))
    value = String.fromCharCode(65 + ((next - 1) % 26)) + value;
  return value;
}
function header(size: number, signature: number) {
  const data = new Uint8Array(size),
    view = new DataView(data.buffer);
  view.setUint32(0, signature, true);
  return { data, view };
}
function zip(files: ReadonlyArray<readonly [string, string]>) {
  const locals: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0,
    centralBytes = 0;
  for (const [path, value] of files) {
    const name = encoder.encode(path),
      bytes = encoder.encode(value),
      crc = crc32(bytes),
      local = header(30, 0x04034b50),
      record = header(46, 0x02014b50);
    local.view.setUint16(4, 20, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, bytes.length, true);
    local.view.setUint32(22, bytes.length, true);
    local.view.setUint16(26, name.length, true);
    record.view.setUint16(4, 20, true);
    record.view.setUint16(6, 20, true);
    record.view.setUint32(16, crc, true);
    record.view.setUint32(20, bytes.length, true);
    record.view.setUint32(24, bytes.length, true);
    record.view.setUint16(28, name.length, true);
    record.view.setUint32(42, offset, true);
    locals.push(local.data, name, bytes);
    central.push(record.data, name);
    offset += local.data.length + name.length + bytes.length;
    centralBytes += record.data.length + name.length;
  }
  const end = header(22, 0x06054b50);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralBytes, true);
  end.view.setUint32(16, offset, true);
  return new Blob(
    [...locals, ...central, end.data].map((part) => new Uint8Array(part).buffer),
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  );
}
export function catalogWorkbook(
  columns: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
) {
  if (rows.length > 70000 || columns.length > 50)
    throw new Error('Workbook exceeds the supported catalog size.');
  const data = [columns, ...rows]
    .map(
      (row, index) =>
        `<row r="${index + 1}">${row.map((value, column) => `<c r="${columnName(column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`,
    )
    .join('');
  return zip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Catalog" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`,
    ],
  ]);
}
