import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '../../domain/errors.js';
import type { ClosedExportFile } from '../operational-reports/export-artifact.js';
import type { InventoryWorkbookOptions } from './options.js';

const unavailable = () =>
  new AppError(503, 'WORKBOOK_STAGING_UNAVAILABLE', 'Private report staging is unavailable.');
const overflow = () =>
  new AppError(422, 'EXPORT_TOO_LARGE', 'The report exceeds the allowed file limit.');
const privateMode = (mode: number) => (mode & 0o077) === 0;
export interface ClosedWorkbookSpool extends ClosedExportFile {
  readRange(offset: number, length: number): Promise<Uint8Array>;
}
async function privateRoot(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !privateMode(info.mode) ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw unavailable();
}
export async function createExportSpool(
  options: InventoryWorkbookOptions,
  maxBytes: number,
  signal: AbortSignal,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 268435456) throw overflow();
  signal.throwIfAborted();
  await privateRoot(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY);
  const directory = await mkdtemp(
    join(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY, `export-${randomUUID()}-`),
  );
  const path = join(directory, 'artifact');
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch(async () => {
    await rm(directory, { recursive: true, force: true });
    throw unavailable();
  });
  const digest = createHash('sha256');
  let bytes = 0,
    closed = false,
    disposed = false,
    checksum: string | null = null;
  const abort = () => {
    void file.close().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', abort);
    await file.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  };
  if (signal.aborted) {
    await dispose();
    signal.throwIfAborted();
  }
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array) || closed || disposed) throw unavailable();
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw overflow();
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        signal.throwIfAborted();
        const result = await file.write(chunk, offset, chunk.byteLength - offset);
        if (result.bytesWritten <= 0) throw unavailable();
        offset += result.bytesWritten;
      }
    },
    async close() {
      signal.throwIfAborted();
      await file.sync();
      await file.close();
      closed = true;
      checksum = digest.digest('hex');
      signal.removeEventListener('abort', abort);
    },
    async abort() {
      await dispose();
    },
  });
  return {
    writable,
    dispose,
    async seal(): Promise<ClosedWorkbookSpool> {
      signal.throwIfAborted();
      if (!closed || disposed || !checksum || bytes === 0) throw unavailable();
      const identity = await lstat(path);
      if (
        !identity.isFile() ||
        identity.isSymbolicLink() ||
        identity.size !== bytes ||
        !privateMode(identity.mode)
      )
        throw unavailable();
      const sealedChecksum = checksum;
      return {
        byteCount: bytes,
        checksum: sealedChecksum,
        dispose,
        async readRange(offset: number, length: number) {
          if (
            disposed ||
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            offset > bytes ||
            length > 8 * 1024 * 1024
          )
            throw unavailable();
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const current = await handle.stat();
            if (
              !current.isFile() ||
              current.size !== bytes ||
              current.ino !== identity.ino ||
              current.dev !== identity.dev ||
              current.nlink !== 1
            )
              throw unavailable();
            const result = new Uint8Array(Math.min(length, bytes - offset));
            let read = 0;
            while (read < result.length) {
              const value = await handle.read(result, read, result.length - read, offset + read);
              if (!value.bytesRead) throw unavailable();
              read += value.bytesRead;
            }
            return result;
          } finally {
            await handle.close();
          }
        },
        async open(readSignal?: AbortSignal): Promise<Readable> {
          readSignal?.throwIfAborted();
          if (disposed) throw unavailable();
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const current = await handle.stat();
          if (
            !current.isFile() ||
            current.size !== bytes ||
            current.ino !== identity.ino ||
            current.dev !== identity.dev ||
            current.nlink !== 1
          ) {
            await handle.close();
            throw unavailable();
          }
          const body = handle.createReadStream({ autoClose: true, signal: readSignal });
          body.on('error', () => undefined);
          return body;
        },
      };
    },
  };
}
/** Own UUID directories only; streaming iteration and a bounded scan avoid unbounded RAM/work. */
export async function pruneInventoryWorkbookStaging(
  options: InventoryWorkbookOptions,
  now = Date.now(),
  maxEntries = 1000,
): Promise<number> {
  await privateRoot(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY);
  const directory = await opendir(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY);
  let scanned = 0,
    removed = 0;
  for await (const entry of directory) {
    if (scanned++ >= Math.min(1000, Math.max(1, maxEntries))) break;
    if (
      !entry.isDirectory() ||
      !/^export-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[A-Za-z0-9_-]{6}$/.test(
        entry.name,
      )
    )
      continue;
    const path = join(options.INVENTORY_WORKBOOK_STAGING_DIRECTORY, entry.name),
      info = await lstat(path).catch(() => null);
    if (
      !info ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !privateMode(info.mode) ||
      (process.getuid && info.uid !== process.getuid()) ||
      info.mtimeMs + options.INVENTORY_WORKBOOK_STAGING_TTL_MS >= now
    )
      continue;
    await rm(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
