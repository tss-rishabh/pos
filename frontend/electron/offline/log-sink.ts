import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface JsonlSinkOptions {
  /** Directory for the log files (Electron `app.getPath('logs')`). */
  directory: string;
  /** Current file name; rotated files get `.1` (newest) to `.<maxFiles>` (oldest). */
  fileName?: string;
  /** Rotate before a write would take the current file past this size. */
  maxBytes?: number;
  /** Rotated files kept besides the current one. */
  maxFiles?: number;
  /** Also echo each line to stdout (unpackaged development runs only). */
  stdout?: boolean;
}
export interface JsonlSink {
  write(record: object): void;
  close(): void;
}

export const DEFAULT_LOG_FILE = 'retail-pos.jsonl';
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_LOG_FILES = 3;
/** A single record is never larger than this (records carry IDs and codes only). */
const MAX_LINE_BYTES = 8 * 1024;

/**
 * Size-capped, rotating JSON Lines file. Writes are synchronous so the last lines before a crash
 * reach the disk, and a logging failure never throws into the caller: logging must not break
 * billing. The file is closed before rotation, so renaming works on Windows as on macOS.
 */
export function jsonlSink(options: JsonlSinkOptions): JsonlSink {
  const fileName = options.fileName ?? DEFAULT_LOG_FILE,
    maxBytes = Math.max(MAX_LINE_BYTES, options.maxBytes ?? DEFAULT_MAX_LOG_BYTES),
    maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_LOG_FILES),
    path = join(options.directory, fileName);
  let fd: number | null = null,
    size = 0,
    broken = false;
  function open() {
    mkdirSync(options.directory, { recursive: true });
    fd = openSync(path, 'a', 0o600);
    size = fstatSync(fd).size;
  }
  function rotate() {
    if (fd !== null) closeSync(fd);
    fd = null;
    rmSync(`${path}.${maxFiles}`, { force: true });
    for (let index = maxFiles - 1; index >= 1; index--)
      try {
        renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      } catch {
        /* A missing older file is expected. */
      }
    renameSync(path, `${path}.1`);
    open();
  }
  return {
    write(record) {
      let line: string;
      try {
        line = JSON.stringify(record) + '\n';
      } catch {
        return;
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
      if (options.stdout) process.stdout.write(line);
      if (broken) return;
      try {
        if (fd === null) open();
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate();
        size += writeSync(fd!, line);
      } catch {
        // Disk full or not writable: stop trying for this run instead of failing every call.
        broken = true;
        try {
          if (fd !== null) closeSync(fd);
        } catch {
          /* Already closed. */
        }
        fd = null;
      }
    },
    close() {
      if (fd !== null)
        try {
          closeSync(fd);
        } catch {
          /* Already closed. */
        }
      fd = null;
    },
  };
}
