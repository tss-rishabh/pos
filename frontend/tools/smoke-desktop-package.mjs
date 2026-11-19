// Packaged-app runtime smoke for the unsigned review build on its native OS (release/<target>).
//
// The packaged app refuses Chromium remote debugging and the mock keychain, and its fuses disable
// the Node inspector, so it is not driven over CDP: a synthetic loopback workspace page reports
// what it observes (see desktop-native-fixture.mjs). The checks:
//   - the debugging and mock-keychain switches make the packaged app exit 1 without a profile;
//   - the renderer has no Node access and external navigation and popups are blocked;
//   - offline billing starts in the packaged app: the SQLCipher module loads from
//     resources/offline-sqlite and the OS keystore (Windows DPAPI, macOS Keychain) wraps the key;
//   - a second instance on the same profile exits and leaves the first running;
//   - local state survives a native restart, and the shell reloads offline from its service worker;
//   - the device database is unreadable without its key and, on Windows, opens with the key that
//     real DPAPI releases for this user.
// The profile path contains spaces and a non-ASCII character on purpose.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  baseEnvironment,
  closeServer,
  inspectOfflineDatabase,
  launchNative,
  listen,
  quitNative,
  startWorkspaceFixture,
  unwrapWithWindowsDpapi,
  waitExit,
} from './desktop-native-fixture.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const platform =
  process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform;
const architecture = process.arch;
// Windows DPAPI needs no prompt and is per user, so it is always exercised. On macOS the real
// login Keychain is used only on CI runners, never on a developer's machine.
const requireKeystore = platform === 'windows' || process.env.CI === 'true';
let stage = 'preflight';
let failureStage = null;
const evidenceDirectory = join(project, '..', 'backend', 'evidence');
const evidenceFile = join(evidenceDirectory, `desktop-runtime-${platform}-${architecture}.json`);
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
// release/: the review/release flavour. release-smoke/: the CI-only native-smoke flavour, the
// one packaged build that accepts a loopback origin and an isolated profile, and only with
// POS_DESKTOP_NATIVE_SMOKE=1 (electron/runtime-mode.cjs).
const packagedExecutable = (root) =>
  folder
    ? join(
        project,
        root,
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
const executable = packagedExecutable('release-smoke');
const releaseExecutable = packagedExecutable('release');
const smokeEnvironment = () => ({ ...baseEnvironment(), POS_DESKTOP_NATIVE_SMOKE: '1' });
const defaultProfile =
  platform === 'windows'
    ? join(process.env.APPDATA ?? '', packageJson.productName)
    : join(homedir(), 'Library', 'Application Support', packageJson.productName);
const emit = (passed, errorCode, detail) =>
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
      ...(detail ? { detail } : {}),
    }) + '\n',
  );

/** Each refused switch must exit 1 before the app writes anything into its profile. */
async function refusedSwitches() {
  const results = [];
  for (const args of [
    ['--remote-debugging-port=0'],
    ['--remote-debugging-pipe'],
    ['--use-mock-keychain'],
  ]) {
    const profile = mkdtempSync(join(tmpdir(), 'pos refused ü-'));
    try {
      const app = launchNative(executable, args, {
        ...smokeEnvironment(),
        POS_DESKTOP_URL: 'http://127.0.0.1:9',
        POS_DESKTOP_PROFILE_DIR: profile,
      });
      const result = await waitExit(app, 20000);
      if (!result) await quitNative(app);
      assert.ok(result, `PACKAGE_SWITCH_NOT_REFUSED_${args[0]}`);
      assert.equal(result.code, 1, `PACKAGE_SWITCH_EXIT_${args[0]}`);
      const written = readdirSync(profile);
      assert.deepEqual(written, [], `PACKAGE_SWITCH_WROTE_PROFILE_${args[0]}`);
      results.push({ switch: args[0].replace(/=.*$/, ''), exitCode: result.code, profileFiles: 0 });
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }
  return results;
}

/**
 * Packaged builds ignore NODE_ENV (and, in a release build, the smoke variable): with
 * NODE_ENV=development they must neither accept a loopback http workspace origin nor use
 * POS_DESKTOP_PROFILE_DIR. The workspace server must receive no request and the override directory
 * must stay empty. (DevTools follow the same runtime-mode gate; tests/desktop-runtime-mode.test.ts
 * covers it and the static verifier proves the packaged gate files equal the source.) The app
 * then shows its configuration error, so it is closed. A default profile created only by this
 * check is removed again; an existing one is never touched.
 */
async function packagedIgnoresDevelopment() {
  const results = [];
  const variants = [
    ['release', releaseExecutable, { NODE_ENV: 'development', POS_DESKTOP_NATIVE_SMOKE: '1' }],
    ['native-smoke-without-launch-variable', executable, { NODE_ENV: 'development' }],
  ];
  for (const [flavour, file, extra] of variants) {
    assert.ok(file && existsSync(file), `RELEASE_PACKAGE_REQUIRED_${flavour}`);
    const override = mkdtempSync(join(tmpdir(), 'pos ignored profile ü-'));
    const hadDefaultProfile = existsSync(defaultProfile);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('<!doctype html><title>must not load</title>');
    });
    try {
      const port = await listen(server);
      const app = launchNative(file, [], {
        ...baseEnvironment(),
        ...extra,
        POS_DESKTOP_URL: `http://127.0.0.1:${port}`,
        POS_DESKTOP_PROFILE_DIR: override,
      });
      await waitExit(app, 10000);
      await quitNative(app);
      assert.equal(requests, 0, `PACKAGED_ACCEPTED_DEVELOPMENT_ORIGIN_${flavour}`);
      assert.deepEqual(readdirSync(override), [], `PACKAGED_USED_PROFILE_OVERRIDE_${flavour}`);
      results.push({ flavour, loopbackHttpOriginRequests: 0, profileOverrideFiles: 0 });
    } finally {
      await closeServer(server);
      rmSync(override, { recursive: true, force: true });
      if (!hadDefaultProfile)
        rmSync(defaultProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }
  return results;
}

async function main() {
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(process.argv.length, 2);
  rmSync(evidenceFile, { force: true });
  assert.ok(executable && existsSync(executable), 'NATIVE_DESKTOP_PACKAGE_REQUIRED');
  stage = 'static-artifact-validation';
  await promisify(execFile)(process.execPath, [join(project, 'tools/verify-desktop-package.mjs')], {
    cwd: project,
    env: baseEnvironment(),
    timeout: 30000,
  });
  stage = 'refused-switches';
  const refused = await refusedSwitches();
  stage = 'packaged-ignores-development';
  const ignoredDevelopment = await packagedIgnoresDevelopment();
  const profile = mkdtempSync(join(tmpdir(), 'pos packaged runtime ü-'));
  const fixture = await startWorkspaceFixture();
  const environment = {
    ...smokeEnvironment(),
    POS_DESKTOP_URL: fixture.origin,
    POS_DESKTOP_PROFILE_DIR: profile,
  };
  const apps = [];
  const launch = () => {
    const app = launchNative(executable, [], environment);
    apps.push(app);
    return app;
  };
  const quits = [];
  let database = null;
  try {
    stage = 'initial-native-launch';
    let mark = fixture.reports.length;
    let app = launch();
    const first = await fixture.waitFor('loaded', mark);
    stage = 'renderer-isolation';
    assert.deepEqual(
      { require: first.require, process: first.process, bridge: first.bridge },
      { require: 'undefined', process: 'undefined', bridge: 'object' },
    );
    assert.equal(first.canary, null, 'PROFILE_NOT_FRESH');
    stage = 'offline-worker-and-billing';
    const ready = await fixture.waitFor('ready', mark, 60000);
    assert.equal(ready.worker, 'controlling', 'SERVICE_WORKER_NOT_CONTROLLING');
    assert.equal(ready.canary, fixture.nonce);
    assert.ok(ready.status, `OFFLINE_BRIDGE_STATUS_${ready.error ?? 'MISSING'}`);
    if (requireKeystore)
      assert.equal(
        ready.status.available,
        true,
        `OFFLINE_BILLING_UNAVAILABLE: ${ready.status.unavailableReason}`,
      );
    stage = 'navigation-and-popup-isolation';
    const stayed = await fixture.waitFor('stayed', mark);
    assert.equal(stayed.href, fixture.origin + '/');
    assert.equal(fixture.escapeRequests, 0);
    stage = 'single-instance';
    const second = launch();
    const secondResult = await waitExit(second, 20000);
    assert.ok(secondResult, 'SECOND_INSTANCE_DID_NOT_EXIT');
    assert.equal(app.child.exitCode, null, 'FIRST_INSTANCE_EXITED');
    assert.equal(
      fixture.reports.slice(mark).filter((item) => item.kind === 'loaded').length,
      1,
      'SECOND_INSTANCE_OPENED_A_WINDOW',
    );
    stage = 'initial-native-shutdown';
    quits.push(await quitNative(app));
    stage = 'native-restart';
    mark = fixture.reports.length;
    app = launch();
    stage = 'profile-retention';
    const restarted = await fixture.waitFor('ready', mark, 60000);
    assert.equal(restarted.canary, fixture.nonce);
    if (requireKeystore) assert.equal(restarted.status?.available, true);
    quits.push(await quitNative(app));
    stage = 'offline-renderer-reload';
    await fixture.takeOffline();
    const before = fixture.workspaceRequests;
    mark = fixture.reports.length;
    app = launch();
    const offline = await fixture.waitFor('loaded', mark, 60000);
    assert.equal(offline.canary, fixture.nonce);
    assert.equal(offline.controlled, true, 'OFFLINE_SHELL_NOT_FROM_SERVICE_WORKER');
    const offlineReady = await fixture.waitFor('ready', mark, 60000);
    assert.equal(fixture.workspaceRequests, before);
    if (requireKeystore) assert.equal(offlineReady.status?.available, true);
    quits.push(await quitNative(app));
    assert.ok(
      quits.every((quit) => quit.graceful),
      'PACKAGE_DID_NOT_QUIT_GRACEFULLY',
    );
    stage = 'encrypted-offline-database';
    if (requireKeystore) {
      const wrapped = readFileSync(join(profile, 'offline-billing.key'));
      const key = platform === 'windows' ? unwrapWithWindowsDpapi(profile, wrapped) : null;
      database = inspectOfflineDatabase(profile, key);
      if (key) {
        assert.ok(database.opened.tables.includes('sales'), 'OFFLINE_DB_SCHEMA_MISSING');
        assert.match(database.opened.deviceId ?? '', /^[a-f0-9]{32}$/);
      }
    }
    stage = 'evidence-publication';
    const artifact = JSON.parse(
      readFileSync(
        join(evidenceDirectory, `desktop-package-native-smoke-${platform}-${architecture}.json`),
        'utf8',
      ),
    );
    writeFileSync(
      evidenceFile,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          scope: 'packaged-native-runtime-with-controlled-local-fixture',
          platform,
          architecture,
          keychain: requireKeystore
            ? platform === 'windows'
              ? 'windows-dpapi-current-user'
              : 'macos-login-keychain-ci-runner'
            : 'not-exercised-on-developer-machine',
          executableSha256: artifact.executableSha256,
          asarSha256: artifact.asarSha256,
          flavour: 'ci-native-smoke (posDesktopNativeSmoke + POS_DESKTOP_NATIVE_SMOKE=1)',
          refusedSwitches: refused,
          packagedIgnoresNodeEnvDevelopment: ignoredDevelopment,
          offlineDatabase: database
            ? {
                plaintextHeader: false,
                opensWithoutKey: false,
                opensWithWrongKey: false,
                wrappedKeyPrefix: database.wrappedKeyPrefix,
                opensWithOsReleasedKey: database.opened ? true : null,
                tables: database.opened?.tables.length ?? null,
              }
            : null,
          checks: [
            'packaged-entry-load',
            'debugging-and-mock-keychain-switches-refused',
            'packaged-ignores-node-env-development-origin-and-profile',
            'renderer-node-access-absent',
            'external-navigation-and-popups-blocked',
            ...(requireKeystore ? ['offline-billing-available-with-os-keystore'] : []),
            'second-instance-exits',
            'graceful-native-quit',
            'profile-keeps-local-state-across-native-restart',
            'service-worker-offline-reload',
            ...(database?.opened ? ['offline-database-opens-only-with-dpapi-released-key'] : []),
          ],
          profilePath: 'temporary directory with spaces and a non-ASCII character',
          passed: true,
          releaseCertified: false,
          limitations: [
            'Uses the explicit development-only loopback origin with a synthetic page; does not certify production TLS, authentication, signatures, payment integrations or physical printers.',
            'The packaged app is observed through its own page and the file system; no debugging port is opened.',
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
    await Promise.allSettled(apps.map((app) => quitNative(app)));
    await fixture.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  emit(true);
}
main().catch((error) => {
  // Assertion codes only: no paths, keys or page content.
  const code = error instanceof Error ? String(error.message).split(/[\n:]/)[0].slice(0, 120) : '';
  emit(false, 'DESKTOP_PACKAGE_RUNTIME_FAILED', code);
  process.exitCode = 1;
});
