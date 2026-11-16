import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Use the archive/fuse tools owned by the pinned packager dependency tree.
// No packaged code is executed, and no application profile is opened.
const require = createRequire(import.meta.url);
const builderTools = createRequire(require.resolve('app-builder-lib/package.json'));
const { extractFile, getRawHeader } = builderTools('@electron/asar');
const { getCurrentFuseWire } = builderTools('@electron/fuses');
const plist = builderTools('plist');
const project = fileURLToPath(new URL('..', import.meta.url));
const source = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const policy = [
  ['RunAsNode', false],
  ['EnableCookieEncryption', true],
  ['EnableNodeOptionsEnvironmentVariable', false],
  ['EnableNodeCliInspectArguments', false],
  ['EnableEmbeddedAsarIntegrityValidation', true],
  ['OnlyLoadAppFromAsar', true],
  ['LoadBrowserProcessSpecificV8Snapshot', false],
  ['GrantFileProtocolExtraPrivileges', false],
  ['WasmTrapHandlers', true],
];
const candidates = [
  ['macos', 'arm64', 'mac-arm64'],
  ['macos', 'x64', 'mac'],
  ['macos', 'x64', 'mac-x64'],
  ['windows', 'x64', 'win-unpacked'],
  ['windows', 'arm64', 'win-arm64-unpacked'],
];

function emit(platform, architecture, passed, code) {
  process.stdout.write(
    JSON.stringify({
      module: 'desktop-build',
      resource: 'package',
      eventId: 'desktop-build.package.' + (passed ? 'verified' : 'failed'),
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      platform,
      architecture,
      passed,
      ...(code ? { errorCode: code } : {}),
    }) + '\n',
  );
}

async function verify(platform, architecture, folder) {
  const mac = platform === 'macos';
  const directory = join(project, 'release', folder);
  const application = mac ? join(directory, source.build.productName + '.app') : directory;
  const executable = mac
    ? join(application, 'Contents', 'MacOS', source.build.productName)
    : join(application, source.build.productName + '.exe');
  if (!existsSync(executable)) return false;
  const fuseTarget = mac ? application : executable;
  const wire = await getCurrentFuseWire(fuseTarget);
  if (
    wire.version !== '1' ||
    Object.keys(wire).filter((key) => /^\d+$/.test(key)).length !== policy.length ||
    policy.some(([, enabled], index) => wire[index] !== (enabled ? 49 : 48))
  )
    throw new Error('DESKTOP_PACKAGE_FUSE_POLICY');
  const resources = mac
    ? join(application, 'Contents', 'Resources')
    : join(application, 'resources');
  const archive = join(resources, 'app.asar');
  const header = getRawHeader(archive),
    headerHash = sha256(header.headerString);
  let dependencyFiles = 0;
  function countDependencies(node, inside = false) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const dependency = inside || name === 'node_modules';
      if (child.files) countDependencies(child, dependency);
      else if (dependency) dependencyFiles++;
    }
  }
  countDependencies(JSON.parse(header.headerString));
  if (dependencyFiles) throw new Error('DESKTOP_PACKAGE_DUPLICATE_WEB_DEPENDENCIES');
  const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (
    ['name', 'version', 'main'].some((key) => source[key] !== packaged[key]) ||
    source.main !== 'electron/main.cjs' ||
    sha256(extractFile(archive, source.main)) !== sha256(readFileSync(join(project, source.main)))
  )
    throw new Error('DESKTOP_PACKAGE_ENTRY_MISMATCH');
  let embeddedHashMatches = null;
  if (mac) {
    const info = plist.parse(readFileSync(join(application, 'Contents', 'Info.plist'), 'utf8'));
    const integrity = info.ElectronAsarIntegrity?.['Resources/app.asar'];
    embeddedHashMatches = integrity?.algorithm === 'SHA256' && integrity.hash === headerHash;
    if (!embeddedHashMatches) throw new Error('DESKTOP_PACKAGE_INTEGRITY_METADATA');
  }
  const report = {
    version: 1,
    scope: 'packaged-artifact-static-verification',
    platform,
    architecture,
    sourceInputs: {
      packageJsonSha256: sha256(readFileSync(join(project, 'package.json'))),
      mainCjsSha256: sha256(readFileSync(join(project, source.main))),
    },
    executableSha256: sha256(readFileSync(executable)),
    asarSha256: sha256(readFileSync(archive)),
    asarBytes: statSync(archive).size,
    duplicatedNodeDependencyFiles: dependencyFiles,
    headerHash,
    embeddedHashMatches,
    entryMatchesSource: true,
    applicationIdentityMatchesSource: true,
    fuses: policy.map(([name, enabled]) => ({ name, enabled })),
    releaseCertified: false,
    limitations: [
      'Static verification does not certify installation, signatures, printers, cookie-store upgrades or runtime authorization.',
      ...(mac
        ? []
        : [
            'Windows PE integrity-resource validation and signed runtime behavior require the native release checks.',
          ]),
    ],
  };
  writeFileSync(
    join(project, '..', 'backend', 'evidence', `desktop-package-${platform}-${architecture}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  emit(platform, architecture, true);
  return true;
}

try {
  if (process.versions.node.split('.')[0] !== '24' || process.argv.length !== 2)
    throw new Error('DESKTOP_PACKAGE_RUNTIME');
  let verified = 0;
  for (const candidate of candidates) if (await verify(...candidate)) verified++;
  if (!verified) throw new Error('DESKTOP_PACKAGE_MISSING');
} catch (error) {
  const codes = new Set([
    'DESKTOP_PACKAGE_FUSE_POLICY',
    'DESKTOP_PACKAGE_ENTRY_MISMATCH',
    'DESKTOP_PACKAGE_DUPLICATE_WEB_DEPENDENCIES',
    'DESKTOP_PACKAGE_INTEGRITY_METADATA',
    'DESKTOP_PACKAGE_RUNTIME',
    'DESKTOP_PACKAGE_MISSING',
  ]);
  emit(
    null,
    null,
    false,
    codes.has(error?.message) ? error.message : 'DESKTOP_PACKAGE_UNAVAILABLE',
  );
  process.exitCode = 1;
}
