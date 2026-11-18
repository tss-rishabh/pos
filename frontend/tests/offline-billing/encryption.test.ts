import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OfflineDatabaseLockedError,
  offlineStore,
  openEncryptedDatabase,
} from '../../electron/offline/database';
import {
  loadOrCreateDatabaseKey,
  OfflineKeyUnavailableError,
  type SecretWrapper,
} from '../../electron/offline/key-store';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pos-offline-billing-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('encrypted offline database', () => {
  it('cannot be opened or read without the device key', async () => {
    const filename = join(directory, 'offline-billing.db'),
      key = randomBytes(32);
    const db = openEncryptedDatabase(Database, filename, key);
    offlineStore(db).setMeta('marker', 'PLAINTEXT-MARKER-OFFLINE-SALE');
    db.close();

    const bytes = await readFile(filename);
    expect(bytes.subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\0');
    expect(bytes.includes(Buffer.from('PLAINTEXT-MARKER-OFFLINE-SALE'))).toBe(false);

    // A plain SQLite open (no key) cannot read the file.
    const plain = new Database(filename);
    expect(() => plain.prepare('SELECT count(*) FROM sqlite_master').get()).toThrow(
      /not a database|encrypted/i,
    );
    plain.close();

    // The wrong key fails closed; the file is left untouched.
    expect(() => openEncryptedDatabase(Database, filename, randomBytes(32))).toThrow(
      OfflineDatabaseLockedError,
    );
    expect((await stat(filename)).size).toBe(bytes.length);

    const reopened = openEncryptedDatabase(Database, filename, key);
    expect(offlineStore(reopened).getMeta('marker')).toBe('PLAINTEXT-MARKER-OFFLINE-SALE');
    reopened.close();
  });
  it('rejects keys that are not 256 bits', () => {
    expect(() => openEncryptedDatabase(Database, join(directory, 'x.db'), randomBytes(16))).toThrow(
      RangeError,
    );
  });
});

describe('safeStorage-wrapped device key', () => {
  // Stand-in for the OS keystore: reversible but distinct from the plaintext.
  const wrapper: SecretWrapper = {
    available: async () => true,
    encrypt: async (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)),
    decrypt: async (wrapped) => Buffer.from(wrapped.map((byte) => byte ^ 0x5a)).toString('utf8'),
  };
  it('creates a random key once, stores only the wrapped form, and reloads it', async () => {
    const filename = join(directory, 'offline-billing.key');
    const first = await loadOrCreateDatabaseKey(wrapper, filename);
    expect(first.created).toBe(true);
    expect(first.key).toHaveLength(32);
    const stored = await readFile(filename);
    expect(stored.includes(Buffer.from(first.key.toString('hex')))).toBe(false);
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600);
    const second = await loadOrCreateDatabaseKey(wrapper, filename);
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });
  it('refuses to run without OS key storage', async () => {
    await expect(
      loadOrCreateDatabaseKey({ ...wrapper, available: async () => false }, join(directory, 'k')),
    ).rejects.toBeInstanceOf(OfflineKeyUnavailableError);
  });
  it('never replaces an unreadable wrapped key', async () => {
    const filename = join(directory, 'offline-billing.key');
    await writeFile(filename, 'garbage');
    await expect(
      loadOrCreateDatabaseKey(
        {
          ...wrapper,
          decrypt: async () => {
            throw new Error('keychain denied');
          },
        },
        filename,
      ),
    ).rejects.toBeInstanceOf(OfflineKeyUnavailableError);
    expect((await readFile(filename)).toString()).toBe('garbage');
  });
});
