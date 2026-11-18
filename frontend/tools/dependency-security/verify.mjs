/** Verify the selected local mitigation before toolchain execution; no dependencies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '../..');
const mode = process.argv.slice(2);
assert(mode.length <= 1 && mode.every((value) => ['--archive-only', '--production'].includes(value)));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const archive = 'picomatch-4.0.7-pos-review.tgz';
const specification = `file:tools/dependency-security/${archive}`;
const checksum = (value) => createHash('sha256').update(value).digest('hex');
const sha512 = (value) => 'sha512-' + createHash('sha512').update(value).digest('base64');
const bytes = readFileSync(join(here, archive));
assert.equal(manifest.activated, true, 'Local mitigation is not selected');
assert.equal(manifest.base.name, 'picomatch');
assert.equal(manifest.base.version, '4.0.7');
assert.equal(manifest.archive.path, archive);
assert.equal(checksum(bytes), manifest.archive.sha256, 'Mitigation archive changed');
const metadata = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
assert.equal(metadata.devDependencies.picomatch, specification);
assert.equal(metadata.overrides.picomatch, '$picomatch');
const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
assert.equal(lock.packages[''].devDependencies.picomatch, specification);
const copies = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/picomatch$/.test(name));
assert.equal(copies.length, 1, 'Every consumer must share the reviewed parser');
function installedCopies(directory) {
  const found = [];
  if (!existsSync(directory)) return found;
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.')) continue;
    const path = join(directory, name);
    assert(!lstatSync(path).isSymbolicLink(), 'Linked packages prevent a complete integrity inventory');
    if (!lstatSync(path).isDirectory()) continue;
    const packages = name.startsWith('@')
      ? readdirSync(path).map((child) => join(path, child))
      : [path];
    for (const packagePath of packages) {
      assert(!lstatSync(packagePath).isSymbolicLink(), 'Linked packages prevent a complete integrity inventory');
      if (basename(packagePath) === 'picomatch')
        found.push(relative(project, packagePath).replaceAll('\\', '/'));
      found.push(...installedCopies(join(packagePath, 'node_modules')));
    }
  }
  return found.sort();
}
if (mode[0] !== '--archive-only')
  assert.deepEqual(installedCopies(join(project, 'node_modules')),
    mode[0] === '--production' ? [] : copies.map(([name]) => name).sort(),
    'Unrecorded or missing installed matcher copy');
for (const [name, entry] of copies) {
  assert.equal(entry.version, '4.0.7');
  assert.equal(entry.resolved, specification);
  assert.equal(entry.integrity, sha512(bytes), 'Lockfile must pin this exact archive');
  assert.equal(entry.dev, true, 'The matcher must remain a development dependency');
  const installed = join(project, name);
  if (mode[0] === '--archive-only') continue;
  if (mode[0] === '--production') {
    assert(!existsSync(installed), 'Development matcher present in production install');
    continue;
  }
  assert(!lstatSync(installed).isSymbolicLink(), 'Installed mitigation must be an owned package');
  for (const file of manifest.files) {
    const target = join(installed, file.path);
    assert(!lstatSync(target).isSymbolicLink(), 'Installed mitigation file is a symlink');
    assert.equal(checksum(readFileSync(target)), file.candidateSha256, 'Installed mitigation differs');
  }
}
process.stdout.write(JSON.stringify({
  eventId: 'dependency-security.picomatch.integrity.completed',
  mode: mode[0] ?? 'installed',
  version: '4.0.7',
  archiveSha256: manifest.archive.sha256,
  copies: copies.length,
  upstreamAdvisory: 'GHSA-fc5q-39xc-vjpf',
  officialPatchedRelease: false,
}) + '\n');
