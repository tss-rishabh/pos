import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';

/** The OS-backed wrapper (Electron safeStorage: macOS Keychain / Windows DPAPI). */
export interface SecretWrapper {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(wrapped: Buffer): Promise<string>;
}

export class OfflineKeyUnavailableError extends Error {
  constructor(message = 'Secure key storage is unavailable on this device.') {
    super(message);
  }
}

/** The wrapped key file is gone but the encrypted database it unlocks is still on disk.
 * A new key could never open that database, so no key is created: the sales in it are kept
 * for support to recover, and offline billing stays off. */
export class OfflineKeyMissingError extends OfflineKeyUnavailableError {
  constructor() {
    super('The offline billing key is missing while offline sales data exists.');
  }
}

const MAX_WRAPPED_BYTES = 16384;

/** True unless the path is definitely absent; any other stat failure counts as present. */
async function mayExist(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
}

/** Load the per-device 256-bit database key, creating it on first use. The
 * plaintext key exists only in main-process memory; on disk it is wrapped by
 * the OS keystore. The wrapped file is written atomically with mode 0600.
 * A key is created only when the database file (and its WAL) does not exist. */
export async function loadOrCreateDatabaseKey(
  wrapper: SecretWrapper,
  filename: string,
  databaseFilename: string,
): Promise<{ key: Buffer; created: boolean }> {
  if (!(await wrapper.available())) throw new OfflineKeyUnavailableError();
  let wrapped: Buffer | null = null;
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size < 1 || info.size > MAX_WRAPPED_BYTES)
      throw new OfflineKeyUnavailableError('The offline billing key file is invalid.');
    wrapped = await readFile(filename);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      if (error instanceof OfflineKeyUnavailableError) throw error;
      throw new OfflineKeyUnavailableError('The offline billing key could not be read.');
    }
  }
  if (wrapped) {
    let hex: string;
    try {
      hex = await wrapper.decrypt(wrapped);
    } catch {
      throw new OfflineKeyUnavailableError('The offline billing key could not be unwrapped.');
    }
    if (!/^[a-f0-9]{64}$/.test(hex))
      throw new OfflineKeyUnavailableError('The offline billing key is invalid.');
    return { key: Buffer.from(hex, 'hex'), created: false };
  }
  for (const path of [databaseFilename, `${databaseFilename}-wal`])
    if (await mayExist(path)) throw new OfflineKeyMissingError();
  const key = randomBytes(32);
  const sealed = await wrapper.encrypt(key.toString('hex'));
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(sealed);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filename);
  } catch {
    await rm(temporary, { force: true });
    throw new OfflineKeyUnavailableError('The offline billing key could not be stored.');
  }
  return { key, created: true };
}
