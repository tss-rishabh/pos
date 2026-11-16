import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import type { ApplicationLinkOptions } from './contracts.js';

export interface ApplicationPackageMetadata {
  filename: 'mpos.apk';
  bytes: number;
  checksum: string;
}
export interface ApplicationPackage {
  describe(): Promise<ApplicationPackageMetadata>;
  open(signal?: AbortSignal): Promise<{ metadata: ApplicationPackageMetadata; stream: Readable }>;
  close(): Promise<void>;
}
const unavailable = () =>
  new AppError(
    503,
    'STAFF_PACKAGE_UNAVAILABLE',
    'The staff application download is temporarily unavailable.',
  );
/** Stage and verify one private immutable snapshot. The approved source file is never modified or removed. */
export function createApplicationPackage(
  config: Pick<Config, 'DEMO_MODE'>,
  options: ApplicationLinkOptions,
): ApplicationPackage | undefined {
  if (config.DEMO_MODE || !options.POS_STAFF_APK_ENABLED) return undefined;
  const path = options.POS_STAFF_APK_PATH,
    checksum = options.POS_STAFF_APK_SHA256,
    bytes = options.POS_STAFF_APK_BYTES;
  if (!path || !checksum || !bytes) throw unavailable();
  const lifetime = new AbortController();
  let directory: string | undefined,
    staged: Promise<string> | undefined,
    closed = false;
  const metadata: ApplicationPackageMetadata = { filename: 'mpos.apk', checksum, bytes };
  async function prepare() {
    if (closed) throw unavailable();
    staged ??= (async () => {
      let stagingDirectory: string | undefined;
      try {
        const source = await open(path!, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await source.stat();
          if (!info.isFile() || info.size !== bytes) throw unavailable();
          stagingDirectory = await mkdtemp(join(tmpdir(), 'pos-application-package-'));
          const snapshot = join(stagingDirectory, 'mpos.apk'),
            hash = createHash('sha256');
          let size = 0,
            prefix = Buffer.alloc(0);
          await pipeline(
            source.createReadStream({ autoClose: false }),
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                size += chunk.byteLength;
                if (size > bytes!) return callback(unavailable());
                if (prefix.length < 4)
                  prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)]);
                hash.update(chunk);
                callback(null, chunk);
              },
            }),
            createWriteStream(snapshot, { flags: 'wx', mode: 0o400 }),
            { signal: lifetime.signal },
          );
          if (
            size !== bytes ||
            hash.digest('hex') !== checksum ||
            prefix.toString('hex') !== '504b0304'
          )
            throw unavailable();
          directory = stagingDirectory;
          return snapshot;
        } finally {
          await source.close();
        }
      } catch {
        if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
        throw unavailable();
      }
    })().catch((error: unknown) => {
      staged = undefined;
      throw error;
    });
    return staged;
  }
  return {
    async describe() {
      await prepare();
      return { ...metadata };
    },
    async open(signal) {
      const snapshot = await prepare();
      if (closed) throw unavailable();
      signal?.throwIfAborted();
      return { metadata: { ...metadata }, stream: createReadStream(snapshot, { signal }) };
    },
    async close() {
      closed = true;
      lifetime.abort();
      await staged?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    },
  };
}
