import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const project = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const platform =
  process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform;
const architecture = process.arch;
let stage = 'preflight';
let failureStage = null;
const evidenceFile = join(
  project,
  '..',
  'backend',
  'evidence',
  `desktop-runtime-${platform}-${architecture}.json`,
);
const folder =
  platform === 'macos'
    ? architecture === 'arm64'
      ? 'mac-arm64'
      : 'mac'
    : platform === 'windows'
      ? architecture === 'arm64'
        ? 'win-arm64-unpacked'
        : 'win-unpacked'
      : null;
const executable = folder
  ? join(
      project,
      'release',
      folder,
      ...(platform === 'macos'
        ? [
            packageJson.build.productName + '.app',
            'Contents',
            'MacOS',
            packageJson.build.productName,
          ]
        : [packageJson.build.productName + '.exe']),
    )
  : null;
const emit = (passed, errorCode) =>
  process.stdout.write(
    JSON.stringify({
      module: 'desktop-build',
      resource: 'package-runtime',
      eventId: 'desktop-build.package-runtime.' + (passed ? 'verified' : 'failed'),
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      platform,
      architecture,
      passed,
      ...(!passed ? { stage: failureStage ?? stage } : {}),
      ...(errorCode ? { errorCode } : {}),
    }) + '\n',
  );
const environment = () => {
  const value = { NODE_ENV: 'development' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'COMSPEC', 'LANG'])
    if (process.env[name]) value[name] = process.env[name];
  return value;
};
const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('FIXTURE_PORT_UNAVAILABLE'));
      else resolve(address.port);
    });
  });
const closeServer = async (server) => {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

async function main() {
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(process.argv.length, 2);
  rmSync(evidenceFile, { force: true });
  assert.ok(executable && existsSync(executable), 'NATIVE_DESKTOP_PACKAGE_REQUIRED');
  stage = 'static-artifact-validation';
  await promisify(execFile)(process.execPath, [join(project, 'tools/verify-desktop-package.mjs')], {
    cwd: project,
    env: environment(),
    timeout: 15000,
  });
  const directory = mkdtempSync(join(tmpdir(), 'pos-packaged-runtime-'));
  const nonce = randomUUID();
  let escapeRequests = 0;
  const escapeServer = createServer((_request, response) => {
    escapeRequests++;
    response.end('Untrusted local fixture.');
  });
  const html = '<!doctype html><title>Packaged POS fixture</title><h1>Packaged POS fixture</h1>';
  const worker = `
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open('packaged-fixture');
  await cache.add('/');
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});`;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'");
    response.setHeader(
      'Content-Type',
      request.url === '/service-worker.js' ? 'text/javascript' : 'text/html',
    );
    response.end(request.url === '/service-worker.js' ? worker : html);
  });
  let running = null;
  async function stop() {
    const current = running;
    running = null;
    if (!current) return;
    await current.page?.close().catch(() => {});
    await current.browser?.close().catch(() => {});
    if (current.child.exitCode === null && current.child.signalCode === null) {
      await Promise.race([current.exited, delay(3000)]);
      if (current.child.exitCode === null && current.child.signalCode === null) {
        current.child.kill('SIGTERM');
        await Promise.race([current.exited, delay(3000)]);
      }
      if (current.child.exitCode === null && current.child.signalCode === null) {
        current.child.kill('SIGKILL');
        await Promise.race([current.exited, delay(3000)]);
      }
      assert.ok(
        current.child.exitCode !== null || current.child.signalCode !== null,
        'PACKAGE_TEARDOWN_FAILED',
      );
    }
  }
  async function launch(origin) {
    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    const child = spawn(
      executable,
      [
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        ...(platform === 'macos' ? ['--use-mock-keychain'] : []),
      ],
      {
        cwd: project,
        env: { ...environment(), POS_DESKTOP_URL: origin, POS_DESKTOP_PROFILE_DIR: directory },
        stdio: 'ignore',
      },
    );
    const exited = new Promise((resolve) => {
      child.once('exit', resolve);
      child.once('error', resolve);
    });
    running = { child, exited, browser: null, page: null };
    const deadline = Date.now() + 15000;
    while (
      !running.browser &&
      Date.now() < deadline &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        running.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 1000,
        });
      } catch {
        await delay(100);
      }
    }
    assert.ok(running.browser, 'PACKAGE_RENDERER_CONNECTION_FAILED');
    while (!running.page && Date.now() < deadline) {
      running.page = running.browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().startsWith(origin));
      if (!running.page) await delay(100);
    }
    assert.ok(running.page, 'PACKAGE_WORKSPACE_NOT_LOADED');
    running.page.setDefaultTimeout(10000);
    running.page.setDefaultNavigationTimeout(10000);
    await running.page
      .getByRole('heading', { name: 'Packaged POS fixture', exact: true })
      .waitFor();
    return running.page;
  }
  try {
    const port = await listen(server);
    const escapePort = await listen(escapeServer);
    const origin = `http://127.0.0.1:${port}`;
    stage = 'initial-native-launch';
    let page = await launch(origin);
    stage = 'renderer-isolation';
    assert.deepEqual(
      await page.evaluate(() => ({
        require: typeof globalThis.require,
        process: typeof globalThis.process,
      })),
      { require: 'undefined', process: 'undefined' },
    );
    stage = 'offline-worker-installation';
    await page.evaluate(async (value) => {
      let timer;
      try {
        await Promise.race([
          (async () => {
            localStorage.setItem('packaged-runtime-canary', value);
            await navigator.serviceWorker.register('/service-worker.js');
            await navigator.serviceWorker.ready;
            if (!navigator.serviceWorker.controller)
              await new Promise((resolve) =>
                navigator.serviceWorker.addEventListener('controllerchange', resolve, {
                  once: true,
                }),
              );
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('FIXTURE_WORKER_TIMEOUT')), 10000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }, nonce);
    stage = 'navigation-and-popup-isolation';
    await page.evaluate((url) => {
      window.open(url, '_blank');
      location.assign(url);
    }, `http://127.0.0.1:${escapePort}/`);
    await delay(750);
    assert.equal(page.url(), origin + '/');
    assert.equal(escapeRequests, 0);
    assert.equal(running.browser.contexts().flatMap((context) => context.pages()).length, 1);
    stage = 'initial-native-shutdown';
    await stop();
    stage = 'native-restart';
    page = await launch(origin);
    stage = 'profile-retention';
    assert.equal(await page.evaluate(() => localStorage.getItem('packaged-runtime-canary')), nonce);
    await closeServer(server);
    stage = 'offline-renderer-reload';
    const response = await page.reload();
    assert.equal(response?.fromServiceWorker(), true);
    await page.getByRole('heading', { name: 'Packaged POS fixture', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('packaged-runtime-canary')), nonce);
    stage = 'evidence-publication';
    const artifactPlatform = platform;
    const artifact = JSON.parse(
      readFileSync(
        join(
          project,
          '..',
          'backend',
          'evidence',
          `desktop-package-${artifactPlatform}-${architecture}.json`,
        ),
        'utf8',
      ),
    );
    writeFileSync(
      join(
        project,
        '..',
        'backend',
        'evidence',
        `desktop-runtime-${artifactPlatform}-${architecture}.json`,
      ),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          scope: 'packaged-native-runtime-with-controlled-local-fixture',
          platform: artifactPlatform,
          architecture,
          keychain: platform === 'macos' ? 'isolated-test-mock' : 'operating-system-default',
          executableSha256: artifact.executableSha256,
          asarSha256: artifact.asarSha256,
          checks: [
            'packaged-entry-load',
            'renderer-node-access-absent',
            'external-navigation-and-popups-blocked',
            'profile-keeps-local-state-across-native-restart',
            'service-worker-offline-reload',
          ],
          passed: true,
          releaseCertified: false,
          limitations: [
            'Uses the explicit development-only loopback origin with a synthetic page; does not certify production TLS, authentication, signatures, payment integrations or physical printers.',
            'Chromium CDP is enabled only on this owned fixture process; packaged Node Inspector and RunAsNode fuses remain disabled.',
            ...(platform === 'macos'
              ? [
                  'Uses Chromium test-keychain isolation for the temporary unsigned fixture; signed production Keychain behavior requires separate native acceptance.',
                ]
              : []),
          ],
        },
        null,
        2,
      ) + '\n',
    );
  } catch (error) {
    failureStage = stage;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      stop(),
      closeServer(server),
      closeServer(escapeServer),
    ]);
    if (cleanup.some((result) => result.status === 'rejected')) {
      failureStage = 'native-cleanup';
      rmSync(
        join(
          project,
          '..',
          'backend',
          'evidence',
          `desktop-runtime-${platform}-${architecture}.json`,
        ),
        { force: true },
      );
      throw new Error('PACKAGE_TEARDOWN_FAILED');
    }
    rmSync(directory, { recursive: true, force: true });
  }
  emit(true);
}
main().catch(() => {
  emit(false, 'DESKTOP_PACKAGE_RUNTIME_FAILED');
  process.exitCode = 1;
});
