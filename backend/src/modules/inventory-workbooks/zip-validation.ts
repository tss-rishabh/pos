import { AppError } from '../../domain/errors.js';
import type { ClosedWorkbookSpool } from './staging.js';
import type { InventoryWorkbookOptions } from './options.js';

export const legacyWorkbookUnverified = () =>
  new AppError(
    409,
    'LEGACY_WORKBOOK_UNVERIFIED',
    'This archived workbook requires safe file reconciliation before download.',
  );
export function acceptedWorkbookPart(name: string) {
  return (
    name === '[Content_Types].xml' ||
    name === '_rels/.rels' ||
    /^docProps\/(?:app|core)\.xml$/.test(name) ||
    /^xl\/(?:workbook|styles|sharedStrings)\.xml$/.test(name) ||
    name === 'xl/_rels/workbook.xml.rels' ||
    /^xl\/theme\/theme\d+\.xml$/.test(name) ||
    /^xl\/worksheets\/sheet[1-9]\d*\.xml$/.test(name)
  );
}
export interface CheckedZipEntry {
  name: string;
  compressed: number;
  uncompressed: number;
  offset: number;
  flags: number;
  method: number;
}
/** Check central-directory bounds/counts before zip.js can allocate untrusted metadata. */
export async function checkWorkbookZip(
  file: ClosedWorkbookSpool,
  options: InventoryWorkbookOptions,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const tailOffset = Math.max(0, file.byteCount - 65557),
    tail = Buffer.from(await file.readRange(tailOffset, file.byteCount - tailOffset));
  let end = -1;
  for (let position = tail.length - 22; position >= 0; position--)
    if (
      tail.readUInt32LE(position) === 0x06054b50 &&
      position + 22 + tail.readUInt16LE(position + 20) === tail.length
    ) {
      end = position;
      break;
    }
  if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0)
    throw legacyWorkbookUnverified();
  const count = tail.readUInt16LE(end + 10),
    sameDisk = tail.readUInt16LE(end + 8),
    size = tail.readUInt32LE(end + 12),
    offset = tail.readUInt32LE(end + 16);
  if (
    count !== sameDisk ||
    count < 3 ||
    count > options.INVENTORY_WORKBOOK_LEGACY_MAX_ENTRIES ||
    size > Math.min(8 * 1024 * 1024, options.INVENTORY_WORKBOOK_LEGACY_MAX_ENTRIES * 4096) ||
    offset + size !== tailOffset + end ||
    offset <= 0
  )
    throw legacyWorkbookUnverified();
  const directory = Buffer.from(await file.readRange(offset, size)),
    entries: CheckedZipEntry[] = [],
    names = new Set<string>();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let position = 0,
    inflated = 0;
  while (position < directory.length) {
    signal.throwIfAborted();
    if (
      entries.length >= count ||
      position + 46 > directory.length ||
      directory.readUInt32LE(position) !== 0x02014b50
    )
      throw legacyWorkbookUnverified();
    const flags = directory.readUInt16LE(position + 8),
      method = directory.readUInt16LE(position + 10),
      compressed = directory.readUInt32LE(position + 20),
      uncompressed = directory.readUInt32LE(position + 24),
      nameLength = directory.readUInt16LE(position + 28),
      extraLength = directory.readUInt16LE(position + 30),
      commentLength = directory.readUInt16LE(position + 32),
      local = directory.readUInt32LE(position + 42),
      next = position + 46 + nameLength + extraLength + commentLength;
    const host = directory.readUInt16LE(position + 4) >>> 8,
      unixType = (directory.readUInt32LE(position + 38) >>> 16) & 0xf000;
    if (
      next > directory.length ||
      directory.readUInt16LE(position + 34) !== 0 ||
      (flags & 0x2041) !== 0 ||
      (host === 3 && unixType !== 0 && unixType !== 0x8000) ||
      ![0, 8].includes(method) ||
      uncompressed === 0 ||
      uncompressed > options.INVENTORY_WORKBOOK_LEGACY_MAX_ENTRY_BYTES ||
      local >= offset ||
      compressed > file.byteCount
    )
      throw legacyWorkbookUnverified();
    const name = utf8.decode(directory.subarray(position + 46, position + 46 + nameLength));
    if (!acceptedWorkbookPart(name) || names.has(name.toLowerCase()))
      throw legacyWorkbookUnverified();
    names.add(name.toLowerCase());
    inflated += uncompressed;
    if (inflated > options.INVENTORY_WORKBOOK_LEGACY_MAX_XML_BYTES)
      throw legacyWorkbookUnverified();
    entries.push({ name, flags, method, compressed, uncompressed, offset: local });
    position = next;
  }
  if (
    entries.length !== count ||
    !names.has('[content_types].xml') ||
    !names.has('_rels/.rels') ||
    !names.has('xl/workbook.xml')
  )
    throw legacyWorkbookUnverified();
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  if (ordered[0]?.offset !== 0) throw legacyWorkbookUnverified();
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]!,
      header = Buffer.from(await file.readRange(entry.offset, 30));
    if (
      header.length !== 30 ||
      header.readUInt32LE(0) !== 0x04034b50 ||
      header.readUInt16LE(6) !== entry.flags ||
      header.readUInt16LE(8) !== entry.method
    )
      throw legacyWorkbookUnverified();
    const nameLength = header.readUInt16LE(26),
      extraLength = header.readUInt16LE(28),
      start = entry.offset + 30 + nameLength + extraLength,
      boundary = ordered[index + 1]?.offset ?? offset;
    if (
      nameLength > 1024 ||
      start + entry.compressed > boundary ||
      boundary - (start + entry.compressed) > 64
    )
      throw legacyWorkbookUnverified();
    if (utf8.decode(await file.readRange(entry.offset + 30, nameLength)) !== entry.name)
      throw legacyWorkbookUnverified();
  }
  return entries;
}
