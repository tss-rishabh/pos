import { Reader, ZipReader } from '@zip.js/zip.js';
import type { Readable } from 'node:stream';
import { AppError } from '../../domain/errors.js';
import type { InventoryWorkbookOptions } from './options.js';
import { createExportSpool, type ClosedWorkbookSpool } from './staging.js';
import { checkWorkbookZip, legacyWorkbookUnverified } from './zip-validation.js';
import {
  finishWorkbookXml,
  workbookXmlValidator,
  type WorkbookXmlState,
} from './xml-validation.js';

class FileReader extends Reader<ClosedWorkbookSpool> {
  constructor(private readonly file: ClosedWorkbookSpool) {
    super(file);
    this.size = file.byteCount;
  }
  override readUint8Array(index: number, length: number) {
    return this.file.readRange(index, length);
  }
}
export async function validateLegacyWorkbook(
  file: ClosedWorkbookSpool,
  options: InventoryWorkbookOptions,
  signal: AbortSignal,
) {
  try {
    const checked = await checkWorkbookZip(file, options, signal),
      names = new Set(checked.map((entry) => entry.name));
    const state: WorkbookXmlState = {
      names,
      overrides: new Map(),
      relationships: new Map(),
      sheets: [],
    };
    const zip = new ZipReader(new FileReader(file), {
      useWebWorkers: false,
      useCompressionStream: true,
    });
    let actualBytes = 0,
      count = 0;
    try {
      for await (const entry of zip.getEntriesGenerator()) {
        signal.throwIfAborted();
        const expected = checked.find((item) => item.name === entry.filename);
        if (
          !expected ||
          entry.directory ||
          entry.encrypted ||
          ++count > checked.length ||
          !entry.getData
        )
          throw legacyWorkbookUnverified();
        const decoder = new TextDecoder('utf-8', { fatal: true }),
          parser = workbookXmlValidator(entry.filename, state);
        let entryBytes = 0;
        await entry.getData(
          new WritableStream<Uint8Array>({
            write(chunk) {
              signal.throwIfAborted();
              entryBytes += chunk.byteLength;
              actualBytes += chunk.byteLength;
              if (
                entryBytes > options.INVENTORY_WORKBOOK_LEGACY_MAX_ENTRY_BYTES ||
                actualBytes > options.INVENTORY_WORKBOOK_LEGACY_MAX_XML_BYTES
              )
                throw legacyWorkbookUnverified();
              parser.write(decoder.decode(chunk, { stream: true }));
            },
            close() {
              parser.write(decoder.decode());
              parser.close();
            },
          }),
          { signal, checkSignature: true, useWebWorkers: false, useCompressionStream: true },
        );
        if (entryBytes !== expected.uncompressed) throw legacyWorkbookUnverified();
      }
      if (count !== checked.length) throw legacyWorkbookUnverified();
      finishWorkbookXml(state);
    } finally {
      await zip.close();
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof AppError && error.code === 'LEGACY_WORKBOOK_UNVERIFIED') throw error;
    throw legacyWorkbookUnverified();
  }
}
/** No legacy bytes reach the browser until the entire bounded archive is accepted. */
export async function safeLegacyWorkbookStream(
  source: Readable,
  options: InventoryWorkbookOptions,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: Readable; size: number }> {
  const spool = await createExportSpool(options, maxBytes, signal);
  let file: ClosedWorkbookSpool | undefined;
  try {
    const writer = spool.writable.getWriter();
    try {
      for await (const value of source as AsyncIterable<unknown>) {
        if (!(value instanceof Uint8Array)) throw legacyWorkbookUnverified();
        signal.throwIfAborted();
        await writer.write(value);
      }
      await writer.close();
    } finally {
      writer.releaseLock();
      source.destroy();
    }
    file = await spool.seal();
    await validateLegacyWorkbook(file, options, signal);
    const body = await file.open(signal),
      artifact = file;
    body.once('close', () => {
      void artifact.dispose().catch(() => undefined);
    });
    return { body, size: file.byteCount };
  } catch (error) {
    await (file?.dispose() ?? spool.dispose());
    throw error;
  }
}
