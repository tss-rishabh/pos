import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, ipcMain, net, safeStorage, type BrowserWindow, type Session } from 'electron';
import { z } from 'zod';
import type { IpcReply, OfflineStatus } from '../../src/offline/billing/contracts';
import { DEFAULT_LIMITS, evaluateLimits } from '../../src/offline/billing/limits';
import {
  offlineStore,
  openEncryptedDatabase,
  type SqliteConstructor,
  type SqliteDatabase,
} from './database';
import { registerOfflineIpc, type IpcHandlers } from './ipc';
import { loadOrCreateDatabaseKey, type SecretWrapper } from './key-store';
import { NetworkUnavailableError, serverApi, type HttpClient, type HttpRequest } from './server';
import { OfflineBillingError, offlineBillingService, type OfflineLogEvent } from './service';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SESSION_COOKIE = 'pos_session';
export const STATUS_EVENT = 'offline:status:changed';

/** PII-free structured log line: identifiers, outcome codes and timings only. */
function log(event: OfflineLogEvent & { channel?: string }) {
  process.stdout.write(
    JSON.stringify({
      module: 'desktop-offline-billing',
      time: new Date().toISOString(),
      ...event,
    }) + '\n',
  );
}

function electronHttp(origin: string, profile: Session): HttpClient {
  return {
    request(request: HttpRequest) {
      return new Promise((resolve, reject) => {
        const url = new URL(request.path, origin);
        if (url.origin !== origin) {
          reject(new NetworkUnavailableError());
          return;
        }
        const call = net.request({
          method: request.method,
          url: url.href,
          session: profile,
          credentials: 'include',
          origin,
          redirect: 'error',
          cache: 'no-store',
        });
        call.setHeader('Accept', 'application/json');
        call.setHeader('X-Request-Id', request.traceId);
        if (request.operatorId) call.setHeader('X-Operator-Id', request.operatorId);
        const timer = setTimeout(() => call.abort(), request.timeoutMs ?? 10000);
        call.on('response', (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              call.abort();
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            clearTimeout(timer);
            let body: unknown = null;
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              body = text ? JSON.parse(text) : null;
            } catch {
              body = null;
            }
            resolve({ status: response.statusCode, body });
          });
          response.on('error', () => {
            clearTimeout(timer);
            reject(new NetworkUnavailableError());
          });
        });
        call.on('error', () => {
          clearTimeout(timer);
          reject(new NetworkUnavailableError());
        });
        call.on('abort', () => {
          clearTimeout(timer);
          reject(new NetworkUnavailableError());
        });
        if (request.body !== undefined) {
          call.setHeader('Content-Type', 'application/json');
          call.write(JSON.stringify(request.body));
        }
        call.end();
      });
    },
  };
}

const wrapper: SecretWrapper = {
  async available() {
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      return false;
    return safeStorage.isAsyncEncryptionAvailable();
  },
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  async decrypt(wrapped) {
    return (await safeStorage.decryptStringAsync(wrapped)).result;
  },
};

function unavailableStatus(reason: string): OfflineStatus {
  return {
    available: false,
    unavailableReason: reason,
    online: net.isOnline(),
    lastContactAt: null,
    operator: null,
    limits: evaluateLimits(DEFAULT_LIMITS, null, 0),
    catalog: { storeId: null, products: 0, refreshedAt: null },
    queue: { queued: 0, syncing: 0, needsManager: 0, synced: 0, voided: 0 },
    syncing: false,
    lastSyncAt: null,
    lastSyncError: null,
  };
}

/** Packaged apps carry the N-API module (lib + this platform's prebuild) in
 * resources/offline-sqlite, outside the ASAR; development uses node_modules. */
function loadSqlite(): SqliteConstructor {
  const load = createRequire(join(app.getAppPath(), 'package.json'));
  const loaded: unknown = app.isPackaged
    ? load(join(process.resourcesPath, 'offline-sqlite'))
    : load('better-sqlite3-multiple-ciphers');
  if (typeof loaded !== 'function') throw new Error('Offline billing storage is unavailable.');
  return loaded as SqliteConstructor;
}

export interface OfflineBillingRuntimeOptions {
  window: BrowserWindow;
  workspaceOrigin: string;
  profile: Session;
}

/** Start desktop offline billing in the Electron main process. Failures leave
 * the online workspace usable and report offline billing as unavailable. */
export async function startOfflineBilling(
  options: OfflineBillingRuntimeOptions,
): Promise<() => void> {
  const { window, workspaceOrigin, profile } = options;
  const trustedSender = (event: unknown) => {
    const parsed = z
      .object({
        sender: z.object({ id: z.number() }),
        senderFrame: z.object({ url: z.string() }).nullable(),
      })
      .safeParse(event);
    if (!parsed.success || !parsed.data.senderFrame) return false;
    try {
      return (
        parsed.data.sender.id === window.webContents.id &&
        new URL(parsed.data.senderFrame.url).origin === workspaceOrigin
      );
    } catch {
      return false;
    }
  };
  const notify = () => {
    if (!window.isDestroyed()) window.webContents.send(STATUS_EVENT);
  };
  let database: SqliteDatabase | null = null;
  try {
    const directory = app.getPath('userData');
    const { key } = await loadOrCreateDatabaseKey(wrapper, join(directory, 'offline-billing.key'));
    try {
      database = openEncryptedDatabase(loadSqlite(), join(directory, 'offline-billing.db'), key);
    } finally {
      key.fill(0);
    }
  } catch (error) {
    // Never delete or replace an existing database: it may hold sold goods.
    const reason =
      error instanceof Error
        ? error.message
        : 'Offline billing storage is unavailable on this device.';
    log({
      eventId: 'offline.storage.unavailable',
      traceId: randomUUID(),
      outcome: 'failed',
      code: 'STORAGE_UNAVAILABLE',
    });
    const status = unavailableStatus(reason);
    const refuse = async () => {
      throw new OfflineBillingError('OFFLINE_BILLING_UNAVAILABLE', reason);
    };
    const handlers: IpcHandlers = {
      'offline:status': () => status,
      'offline:sync:status': () => status,
      'offline:sync:retry': () => status,
      'offline:catalog:search': refuse,
      'offline:catalog:barcode': refuse,
      'offline:catalog:refresh': refuse,
      'offline:sale:create': refuse,
      'offline:sale:list': () => ({ sales: [] }),
      'offline:sale:reprint': refuse,
      'offline:conflict:resolve': refuse,
    };
    return registerOfflineIpc(ipcMain, handlers, trustedSender, log);
  }
  const store = offlineStore(database);
  let deviceId = store.getMeta('device_id');
  if (!deviceId || !/^[a-f0-9]{32}$/.test(deviceId)) {
    deviceId = randomBytes(16).toString('hex');
    store.setMeta('device_id', deviceId);
  }
  const workspaceUrl = new URL(workspaceOrigin);
  const service = offlineBillingService({
    store,
    server: serverApi(electronHttp(workspaceOrigin, profile)),
    deviceId,
    now: () => Date.now(),
    mono: () => performance.now(),
    netOnline: () => net.isOnline(),
    async hasSessionCookie() {
      const cookies = await profile.cookies.get({ url: workspaceUrl.href, name: SESSION_COOKIE });
      return cookies.length > 0;
    },
    log,
    changed: notify,
  });
  const handlers: IpcHandlers = {
    'offline:status': () => service.status(),
    'offline:sync:status': () => service.status(),
    'offline:sync:retry': (_payload, traceId) => service.retry(traceId),
    'offline:catalog:search': async (payload) => ({
      products: await service.searchCatalog(payload),
    }),
    'offline:catalog:barcode': async (payload) => ({ product: await service.byBarcode(payload) }),
    'offline:catalog:refresh': async (_payload, traceId) => ({
      products: await service.refreshCatalog(traceId),
    }),
    'offline:sale:create': (payload, traceId) => service.createSale(payload, traceId),
    'offline:sale:list': (payload) => ({ sales: service.list(payload) }),
    'offline:sale:reprint': (payload) => ({ receipt: service.reprint(payload.saleId) }),
    'offline:conflict:resolve': async (payload, traceId) => ({
      sale: await service.resolve(payload, traceId),
    }),
  };
  const unregister = registerOfflineIpc(ipcMain, handlers, trustedSender, log);
  let beating = false;
  const beat = (catalog = false) => {
    if (beating) return;
    beating = true;
    void service
      .heartbeat(randomUUID(), { catalog })
      .catch(() =>
        log({ eventId: 'offline.heartbeat.failed', traceId: randomUUID(), outcome: 'failed' }),
      )
      .finally(() => {
        beating = false;
      });
  };
  service.tick();
  beat(true);
  const heartbeat = setInterval(() => beat(), 15000);
  const minute = setInterval(() => {
    try {
      service.tick();
    } catch {
      log({ eventId: 'offline.clock.persist', traceId: randomUUID(), outcome: 'failed' });
    }
  }, 60000);
  const navigated = () => beat(true);
  window.webContents.on('did-finish-load', navigated);
  const stop = () => {
    clearInterval(heartbeat);
    clearInterval(minute);
    unregister();
    if (!window.isDestroyed()) window.webContents.removeListener('did-finish-load', navigated);
    try {
      service.tick();
    } finally {
      database?.close();
      database = null;
    }
  };
  app.once('before-quit', stop);
  return stop;
}

export type { IpcReply };
