// Windows NSIS installer lifecycle smoke for the unsigned review build (Windows only).
//
//   DESKTOP_INSTALLER=<release/...-win-x64.exe> DESKTOP_UPGRADE_INSTALLER=<newer version .exe> \
//   DESKTOP_TLS_PFX=<pfx for CN/SAN localhost, trusted by this Windows machine> \
//   DESKTOP_TLS_PASSPHRASE=<its passphrase> node tools/smoke-desktop-installer.mjs
//
// The installers are release builds: no test seam. The workspace is provisioned the production
// way (POS_DESKTOP_URL=https://localhost:<port>), served by the fixture with a per-run certificate
// that CI trusts in the runner's LocalMachine root store for the duration of the job.
//
// 1. Silent per-user install (/S): files, Start-menu shortcut and the HKCU uninstall entry.
// 2. Launch the installed app (https loopback origin, synthetic page; see desktop-native-fixture.mjs)
//    with NODE_ENV=development and POS_DESKTOP_PROFILE_DIR set: a release build ignores both, so
//    it uses its real default profile (%APPDATA%\<productName>) and the override stays empty;
//    offline billing starts, i.e. the SQLCipher module loads and real DPAPI wraps the key. A
//    development loopback http origin is refused (it receives no request).
// 3. A second instance exits and the first keeps running; packaged debugging switches are refused.
// 4. The device database is not plain SQLite, does not open without its key or with a wrong key,
//    and opens with the key that real DPAPI releases for this Windows user.
// 5. Silent upgrade over the running version's install: version, local state, device id and
//    encrypted database survive.
// 6. Silent uninstall: program files, shortcut and uninstall entry go; the profile with the
//    offline database and its wrapped key stays (nsis.deleteAppDataOnUninstall=false), because
//    it may hold unsynced sales.
// Synthetic data only; nothing leaves 127.0.0.1. Run on a disposable CI runner: it installs into
// and leaves data in the current user's profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
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

const require = createRequire(import.meta.url);
const builderTools = createRequire(require.resolve('app-builder-lib/package.json'));
const { extractFile } = builderTools('@electron/asar');
const project = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const productName = packageJson.build.productName;
let stage = 'preflight';

function emit(passed, detail) {
  process.stdout.write(
    JSON.stringify({
      module: 'desktop-build',
      resource: 'windows-installer',
      eventId: 'desktop-build.windows-installer.' + (passed ? 'verified' : 'failed'),
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      passed,
      ...(passed ? {} : { stage, detail }),
    }) + '\n',
  );
}
const powershell = (script) => {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, 'POWERSHELL_FAILED');
  return result.stdout.trim();
};
function uninstallEntries() {
  const output = powershell(
    "$e = @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '" +
      productName +
      "*' } | Select-Object DisplayName, DisplayVersion, InstallLocation, Publisher); ConvertTo-Json -InputObject $e -Compress",
  );
  return output ? JSON.parse(output) : [];
}
function runInstaller(file, label) {
  const started = Date.now();
  const result = spawnSync(file, ['/S'], { timeout: 300000, windowsHide: true });
  assert.equal(result.status, 0, `${label}_EXIT_${result.status}`);
  return Date.now() - started;
}
const packagedVersion = (installDir) =>
  JSON.parse(extractFile(join(installDir, 'resources', 'app.asar'), 'package.json').toString())
    .version;

async function main() {
  assert.equal(process.platform, 'win32', 'WINDOWS_ONLY');
  assert.equal(process.versions.node.split('.')[0], '24');
  const installer = process.env.DESKTOP_INSTALLER ?? '',
    upgrade = process.env.DESKTOP_UPGRADE_INSTALLER ?? '';
  assert.ok(existsSync(installer) && existsSync(upgrade), 'INSTALLERS_REQUIRED');
  const localAppData = process.env.LOCALAPPDATA,
    appData = process.env.APPDATA;
  assert.ok(localAppData && appData);
  const installDir = join(localAppData, 'Programs', productName);
  const executable = join(installDir, productName + '.exe');
  const uninstaller = join(installDir, `Uninstall ${productName}.exe`);
  const userData = join(appData, productName);
  const shortcut = join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    `${productName}.lnk`,
  );
  assert.equal(existsSync(installDir), false, 'ALREADY_INSTALLED');
  assert.equal(existsSync(userData), false, 'PROFILE_ALREADY_EXISTS');
  const evidence = {
    recordedAt: new Date().toISOString(),
    scope: 'windows-nsis-installer-lifecycle-unsigned-review-build',
    platform: 'windows',
    architecture: process.arch,
    installers: [installer, upgrade].map((file) => ({
      name: file.split(/[\\/]/).at(-1),
      bytes: statSync(file).size,
    })),
    steps: {},
  };
  const pfx = process.env.DESKTOP_TLS_PFX ?? '',
    passphrase = process.env.DESKTOP_TLS_PASSPHRASE ?? '';
  assert.ok(existsSync(pfx) && passphrase, 'TLS_FIXTURE_REQUIRED');
  const fixture = await startWorkspaceFixture({ tls: { pfx: readFileSync(pfx), passphrase } });
  const environment = { ...baseEnvironment(), POS_DESKTOP_URL: fixture.origin };
  const apps = [];
  try {
    stage = 'silent-install';
    evidence.steps.install = { ms: runInstaller(installer, 'INSTALL') };
    assert.ok(existsSync(executable), 'INSTALLED_EXECUTABLE_MISSING');
    assert.ok(existsSync(uninstaller), 'UNINSTALLER_MISSING');
    assert.ok(
      existsSync(join(installDir, 'resources', 'offline-sqlite', 'prebuilds', 'win32-x64.node')),
    );
    assert.ok(existsSync(shortcut), 'START_MENU_SHORTCUT_MISSING');
    const installed = uninstallEntries();
    assert.equal(installed.length, 1, 'UNINSTALL_ENTRY_COUNT');
    const firstVersion = packagedVersion(installDir);
    assert.equal(installed[0].DisplayVersion, firstVersion);
    evidence.steps.install.version = firstVersion;
    evidence.steps.install.installLocation = '%LOCALAPPDATA%\\Programs\\' + productName;

    stage = 'refused-switches';
    for (const flag of ['--remote-debugging-port=0', '--use-mock-keychain']) {
      const scratch = mkdtempSync(join(tmpdir(), 'pos installed refused-'));
      const app = launchNative(executable, [flag], {
        ...environment,
        POS_DESKTOP_PROFILE_DIR: scratch,
      });
      const result = await waitExit(app, 20000);
      if (!result) await quitNative(app);
      assert.equal(result?.code, 1, `INSTALLED_SWITCH_NOT_REFUSED_${flag}`);
      assert.deepEqual(readdirSync(scratch), []);
      rmSync(scratch, { recursive: true, force: true });
    }
    evidence.steps.refusedSwitches = ['--remote-debugging-port', '--use-mock-keychain'];

    stage = 'development-origin-refused';
    {
      let requests = 0;
      const plain = createServer((_request, response) => {
        requests++;
        response.end('<!doctype html><title>must not load</title>');
      });
      const port = await listen(plain);
      const refused = launchNative(executable, [], {
        ...baseEnvironment(),
        NODE_ENV: 'development',
        POS_DESKTOP_NATIVE_SMOKE: '1',
        POS_DESKTOP_URL: `http://127.0.0.1:${port}`,
      });
      await waitExit(refused, 10000);
      await quitNative(refused);
      await closeServer(plain);
      assert.equal(requests, 0, 'INSTALLED_ACCEPTED_DEVELOPMENT_HTTP_ORIGIN');
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }

    stage = 'first-launch';
    const override = mkdtempSync(join(tmpdir(), 'pos ignored profile-'));
    let mark = fixture.reports.length;
    let app = launchNative(executable, [], {
      ...environment,
      NODE_ENV: 'development',
      POS_DESKTOP_NATIVE_SMOKE: '1',
      POS_DESKTOP_PROFILE_DIR: override,
    });
    apps.push(app);
    const ready = await fixture.waitFor('ready', mark, 90000);
    assert.equal(
      ready.status?.available,
      true,
      `OFFLINE_UNAVAILABLE ${ready.status?.unavailableReason ?? ready.error}`,
    );
    assert.equal(ready.canary, fixture.nonce);
    const stayed = await fixture.waitFor('stayed', mark);
    assert.equal(stayed.href, fixture.origin + '/');
    assert.equal(fixture.escapeRequests, 0);
    assert.ok(existsSync(join(userData, 'offline-billing.db')), 'DEFAULT_PROFILE_NOT_USED');
    assert.deepEqual(readdirSync(override), [], 'INSTALLED_USED_PROFILE_OVERRIDE');
    rmSync(override, { recursive: true, force: true });
    evidence.steps.packagedIgnoresNodeEnvDevelopment = {
      loopbackHttpOriginRequests: 0,
      profileOverrideFiles: 0,
      defaultProfileUsed: true,
      workspace: 'https://localhost (production provisioning shape, per-run trusted certificate)',
    };

    stage = 'single-instance';
    const second = launchNative(executable, [], environment);
    apps.push(second);
    const secondExit = await waitExit(second, 20000);
    assert.ok(secondExit, 'SECOND_INSTANCE_DID_NOT_EXIT');
    assert.equal(app.child.exitCode, null, 'FIRST_INSTANCE_EXITED');
    assert.equal(fixture.reports.slice(mark).filter((item) => item.kind === 'loaded').length, 1);
    evidence.steps.singleInstance = { secondInstanceExitCode: secondExit.code };
    const firstQuit = await quitNative(app);
    assert.ok(firstQuit.graceful, 'INSTALLED_APP_DID_NOT_QUIT');

    stage = 'dpapi-database';
    const firstKey = unwrapWithWindowsDpapi(
      userData,
      readFileSync(join(userData, 'offline-billing.key')),
    );
    const firstDb = inspectOfflineDatabase(userData, firstKey);
    assert.ok(firstDb.opened.tables.includes('sales'));
    const deviceId = firstDb.opened.deviceId;
    assert.match(deviceId ?? '', /^[a-f0-9]{32}$/);
    evidence.steps.dpapi = {
      localStateKeyProtection: 'DPAPI (CurrentUser)',
      wrappedKeyPrefix: firstDb.wrappedKeyPrefix,
      wrappedKeyBytes: firstDb.wrappedKeyBytes,
      plaintextHeader: false,
      opensWithoutKey: false,
      opensWithWrongKey: false,
      opensWithDpapiReleasedKey: true,
      tables: firstDb.opened.tables.length,
    };

    stage = 'silent-upgrade';
    evidence.steps.upgrade = { ms: runInstaller(upgrade, 'UPGRADE') };
    const upgradedVersion = packagedVersion(installDir);
    assert.notEqual(upgradedVersion, firstVersion, 'UPGRADE_VERSION_UNCHANGED');
    const upgraded = uninstallEntries();
    assert.equal(upgraded.length, 1, 'UPGRADE_LEFT_TWO_ENTRIES');
    assert.equal(upgraded[0].DisplayVersion, upgradedVersion);
    evidence.steps.upgrade.from = firstVersion;
    evidence.steps.upgrade.to = upgradedVersion;
    mark = fixture.reports.length;
    app = launchNative(executable, [], environment);
    apps.push(app);
    const afterUpgrade = await fixture.waitFor('ready', mark, 90000);
    assert.equal(afterUpgrade.status?.available, true, 'OFFLINE_UNAVAILABLE_AFTER_UPGRADE');
    assert.equal(afterUpgrade.canary, fixture.nonce, 'LOCAL_STATE_LOST_ON_UPGRADE');
    assert.ok((await quitNative(app)).graceful);
    const upgradedKey = unwrapWithWindowsDpapi(
      userData,
      readFileSync(join(userData, 'offline-billing.key')),
    );
    assert.equal(upgradedKey, firstKey, 'DEVICE_KEY_CHANGED_ON_UPGRADE');
    assert.equal(inspectOfflineDatabase(userData, upgradedKey).opened.deviceId, deviceId);
    evidence.steps.upgrade.retained = [
      'local-storage',
      'offline-database',
      'device-key',
      'device-id',
    ];

    stage = 'silent-uninstall';
    const started = Date.now();
    const result = spawnSync(uninstaller, ['/S'], { timeout: 120000, windowsHide: true });
    assert.equal(result.status, 0, 'UNINSTALL_EXIT');
    // The NSIS uninstaller re-launches itself from %TEMP% and returns at once.
    while (existsSync(executable) && Date.now() - started < 120000) await delay(500);
    assert.equal(existsSync(executable), false, 'UNINSTALL_LEFT_EXECUTABLE');
    while (uninstallEntries().length && Date.now() - started < 120000) await delay(500);
    assert.equal(uninstallEntries().length, 0, 'UNINSTALL_LEFT_ENTRY');
    assert.equal(existsSync(shortcut), false, 'UNINSTALL_LEFT_SHORTCUT');
    for (const file of ['offline-billing.db', 'offline-billing.key', 'Local State'])
      assert.ok(existsSync(join(userData, file)), `UNINSTALL_REMOVED_${file}`);
    const retainedKey = unwrapWithWindowsDpapi(
      userData,
      readFileSync(join(userData, 'offline-billing.key')),
    );
    assert.equal(inspectOfflineDatabase(userData, retainedKey).opened.deviceId, deviceId);
    evidence.steps.uninstall = {
      ms: Date.now() - started,
      programFilesRemoved: true,
      uninstallEntryRemoved: true,
      startMenuShortcutRemoved: true,
      profileRetained: ['offline-billing.db', 'offline-billing.key', 'Local State'],
      retainedDatabaseOpensWithDpapi: true,
    };
    evidence.passed = true;
    writeFileSync(
      join(project, 'release', 'desktop-installer-windows-x64.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    process.stdout.write(JSON.stringify(evidence) + '\n');
  } finally {
    await Promise.allSettled(apps.map((item) => quitNative(item)));
    await fixture.close();
  }
  emit(true);
}
main().catch((error) => {
  emit(false, error instanceof Error ? String(error.message).split('\n')[0].slice(0, 160) : '');
  process.exitCode = 1;
});
