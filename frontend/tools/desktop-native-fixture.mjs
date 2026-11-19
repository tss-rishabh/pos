// Shared native-desktop fixture for the packaged-app and installer smokes.
//
// Packaged builds refuse Chromium remote debugging and the mock keychain (electron/main.cjs), and
// the fuses disable the Node inspector, so a packaged app cannot be driven over CDP. Instead the
// app is pointed (development-only loopback origin) at a synthetic workspace page whose own
// script reports what it observes to a separate loopback report server: renderer isolation, the
// service-worker shell, localStorage retention, navigation/popup blocking and the offline billing
// bridge status (which proves the SQLCipher module loaded and the OS keystore wrapped the key).
// Synthetic data only; nothing leaves 127.0.0.1.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);

export const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('FIXTURE_PORT_UNAVAILABLE'));
      else resolve(address.port);
    });
  });
export const closeServer = async (server) => {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

/** Only the variables a GUI app needs; never the CI secrets or a developer's environment. */
export function baseEnvironment() {
  const value = { NODE_ENV: 'development' };
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'LANG',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERNAME',
    'PROGRAMDATA',
  ])
    if (process.env[name]) value[name] = process.env[name];
  return value;
}

/**
 * A synthetic workspace origin plus a report server and an "escape" server that must never be
 * reached. `takeOffline()` closes the workspace origin (connection refused), as a store device
 * without network sees it; the page then loads only from its service-worker cache.
 */
export async function startWorkspaceFixture() {
  const nonce = randomUUID();
  const reports = [];
  const waiters = new Set();
  let workspaceRequests = 0,
    escapeRequests = 0;
  const report = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.method !== 'POST' || request.url !== '/report') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body && typeof body === 'object') {
          reports.push({ ...body, receivedAt: Date.now() });
          for (const waiter of waiters) waiter();
        }
      } catch {
        /* ignore malformed fixture reports */
      }
      response.statusCode = 204;
      response.end();
    });
  });
  const escape = createServer((_request, response) => {
    escapeRequests++;
    response.end('Untrusted local fixture.');
  });
  const reportPort = await listen(report);
  const escapePort = await listen(escape);
  const reportOrigin = `http://127.0.0.1:${reportPort}`;
  const escapeOrigin = `http://127.0.0.1:${escapePort}`;
  const html =
    '<!doctype html><meta charset="utf-8"><title>Packaged POS fixture</title><h1>Packaged POS fixture</h1><script src="/fixture.js"></script>';
  const worker = `
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open('packaged-fixture');
  await cache.addAll(['/', '/fixture.js']);
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});`;
  const script = `
(async () => {
  const send = (kind, data) => fetch(${JSON.stringify(reportOrigin)} + '/report', {
    method: 'POST', body: JSON.stringify({ kind, ...data }) }).catch(() => undefined);
  const navigation = performance.getEntriesByType('navigation')[0];
  const canary = localStorage.getItem('packaged-runtime-canary');
  await send('loaded', {
    canary,
    require: typeof globalThis.require,
    process: typeof globalThis.process,
    bridge: typeof window.souledOfflineBilling,
    controlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
    workerStart: navigation ? navigation.workerStart : null,
  });
  if (!canary) localStorage.setItem('packaged-runtime-canary', ${JSON.stringify(nonce)});
  let worker = 'unavailable';
  try {
    await Promise.race([
      (async () => {
        await navigator.serviceWorker.register('/service-worker.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise(resolve =>
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
    ]);
    worker = 'controlling';
  } catch { worker = 'failed'; }
  let status = null, error = null;
  const api = window.souledOfflineBilling;
  for (let attempt = 0; api && attempt < 150; attempt++) {
    try {
      const reply = await api.invoke('offline:status', {});
      if (reply && reply.ok) {
        status = { available: reply.data.available, unavailableReason: reply.data.unavailableReason ?? null };
        break;
      }
      error = reply && reply.error ? reply.error.code : 'unexpected-reply';
    } catch { error = 'bridge-not-ready'; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await send('ready', { worker, status, error, canary: localStorage.getItem('packaged-runtime-canary') });
  window.open(${JSON.stringify(escapeOrigin + '/popup')}, '_blank');
  location.assign(${JSON.stringify(escapeOrigin + '/navigate')});
  setTimeout(() => send('stayed', { href: location.href }), 1000);
})();`;
  const workspace = createServer((request, response) => {
    workspaceRequests++;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; connect-src 'self' ${reportOrigin}; object-src 'none'`,
    );
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path.startsWith('/api/') || path.startsWith('/health')) {
      // The offline billing heartbeat reaches the origin from the main process; there is no
      // store service in this fixture.
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end('{"error":{"code":"NOT_FOUND","message":"No store service in this fixture."}}');
      return;
    }
    if (path === '/service-worker.js' || path === '/fixture.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(path === '/fixture.js' ? script : worker);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  });
  const workspacePort = await listen(workspace);
  const origin = `http://127.0.0.1:${workspacePort}`;
  return {
    origin,
    nonce,
    reports,
    get escapeRequests() {
      return escapeRequests;
    },
    get workspaceRequests() {
      return workspaceRequests;
    },
    /** Reports received since `since` (a reports.length mark) of the given kind. */
    async waitFor(kind, since, timeout = 45000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = reports.slice(since).find((item) => item.kind === kind);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`FIXTURE_REPORT_TIMEOUT_${kind.toUpperCase()}`);
        await new Promise((resolve) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          setTimeout(wake, 250);
        });
      }
    },
    takeOffline: () => closeServer(workspace),
    async close() {
      await Promise.allSettled([closeServer(workspace), closeServer(report), closeServer(escape)]);
    },
  };
}

/** Spawn a native app process; never through a shell. */
export function launchNative(executable, args, env) {
  const child = spawn(executable, args, { env, stdio: 'ignore', windowsHide: false });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: 'spawn-error' }));
  });
  return { child, exited };
}
const running = (child) => child.exitCode === null && child.signalCode === null;
export async function waitExit(app, ms) {
  if (!running(app.child)) return app.exited;
  return Promise.race([app.exited, delay(ms).then(() => null)]);
}

/**
 * Quit like a user closing the window: Windows `taskkill` without /F posts WM_CLOSE to the app's
 * windows; elsewhere SIGTERM runs Electron's normal quit path. Either way `before-quit` closes the
 * encrypted offline database. Forced termination is a last resort and is reported.
 */
export async function quitNative(app) {
  if (!running(app.child)) return { graceful: true, result: await app.exited };
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(app.child.pid)], { stdio: 'ignore', windowsHide: true });
  else app.child.kill('SIGTERM');
  const result = await waitExit(app, 20000);
  if (result) return { graceful: true, result };
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  else app.child.kill('SIGKILL');
  return { graceful: false, result: await waitExit(app, 10000) };
}

/**
 * Unwrap the offline-billing key exactly as Electron safeStorage wrapped it, using only the OS
 * keystore of the current user. Windows: Chromium os_crypt — the AES-256-GCM key in
 * `Local State` (`os_crypt.encrypted_key`, "DPAPI" + CryptProtectData blob) is released by DPAPI
 * for this Windows user only; the wrapped value is "v10" + 12-byte nonce + ciphertext + 16-byte
 * tag. Returns the 64-hex database key, or throws. The key is never logged.
 */
export function unwrapWithWindowsDpapi(profile, wrapped) {
  assert.equal(process.platform, 'win32');
  const state = JSON.parse(readFileSync(join(profile, 'Local State'), 'utf8'));
  const blob = Buffer.from(String(state?.os_crypt?.encrypted_key ?? ''), 'base64');
  assert.equal(blob.subarray(0, 5).toString('latin1'), 'DPAPI', 'LOCAL_STATE_NOT_DPAPI');
  const script =
    'Add-Type -AssemblyName System.Security;' +
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
    "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Console]::Out.Write([Convert]::ToBase64String($k))';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: blob.subarray(5).toString('base64'), encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, 'DPAPI_UNPROTECT_FAILED');
  const aesKey = Buffer.from(result.stdout.trim(), 'base64');
  assert.equal(aesKey.length, 32, 'DPAPI_KEY_LENGTH');
  assert.equal(wrapped.subarray(0, 3).toString('latin1'), 'v10', 'SAFE_STORAGE_PREFIX');
  const nonce = wrapped.subarray(3, 15),
    tag = wrapped.subarray(wrapped.length - 16),
    body = wrapped.subarray(15, wrapped.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  aesKey.fill(0);
  assert.match(plain, /^[a-f0-9]{64}$/, 'UNWRAPPED_KEY_SHAPE');
  return plain;
}

/** macOS Chromium os_crypt (v10: AES-128-CBC, PBKDF2-SHA1 over the Keychain password). */
export function unwrapWithMacPassword(password, wrapped) {
  assert.equal(wrapped.subarray(0, 3).toString('latin1'), 'v10', 'SAFE_STORAGE_PREFIX');
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([decipher.update(wrapped.subarray(3)), decipher.final()]).toString('utf8');
}

/**
 * Inspect the device database from outside the app: it must not be plain SQLite, must not open
 * without its key or with a wrong key, and (when `hexKey` is given) must open with the key the OS
 * keystore released. Returns the device id and table names (no sale content is read).
 */
export function inspectOfflineDatabase(profile, hexKey = null) {
  const filename = join(profile, 'offline-billing.db');
  assert.ok(existsSync(filename), 'OFFLINE_DB_MISSING');
  assert.ok(existsSync(join(profile, 'offline-billing.key')), 'OFFLINE_KEY_MISSING');
  const header = readFileSync(filename).subarray(0, 16).toString('latin1');
  assert.notEqual(header, 'SQLite format 3\0', 'OFFLINE_DB_PLAINTEXT');
  const wrapped = readFileSync(join(profile, 'offline-billing.key'));
  assert.equal(/^[a-f0-9]{64}$/.test(wrapped.toString('latin1')), false, 'OFFLINE_KEY_PLAINTEXT');
  const Database = require('better-sqlite3-multiple-ciphers');
  const attempt = (key) => {
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      if (key) {
        db.pragma(`cipher='sqlcipher'`);
        db.pragma('legacy=4');
        db.key(Buffer.from(key, 'hex'));
      }
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      const device = db.prepare("SELECT value FROM meta WHERE key = 'device_id'").get();
      return { tables, deviceId: device?.value ?? null };
    } finally {
      db.close();
    }
  };
  assert.throws(() => attempt(null), /not a database|encrypted/i, 'OFFLINE_DB_OPENS_WITHOUT_KEY');
  assert.throws(
    () => attempt('00'.repeat(32)),
    /not a database|encrypted/i,
    'OFFLINE_DB_OPENS_WITH_WRONG_KEY',
  );
  return {
    wrappedKeyBytes: wrapped.length,
    wrappedKeyPrefix: wrapped.subarray(0, 3).toString('latin1'),
    opened: hexKey ? attempt(hexKey) : null,
  };
}
