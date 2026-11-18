/** Exercise integrity refusals against owned disposable files, never shared installs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../..');
const archive = 'picomatch-4.0.7-pos-review.tgz';
function fixture(task) {
  const project = mkdtempSync(join(tmpdir(), 'pos-dependency-integrity-'));
  try {
    mkdirSync(join(project, 'tools/dependency-security'), { recursive: true });
    for (const name of ['manifest.json', archive, 'verify.mjs'])
      cpSync(join(here, name), join(project, 'tools/dependency-security', name));
    for (const name of ['package.json', 'package-lock.json'])
      cpSync(join(source, name), join(project, name));
    cpSync(join(source, 'node_modules/picomatch'), join(project, 'node_modules/picomatch'), { recursive: true });
    task(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}
function check(project, ...args) {
  const result = spawnSync(process.execPath, ['tools/dependency-security/verify.mjs', ...args], {
    cwd: project, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, TZ: 'UTC' },
  });
  assert.equal(result.error, undefined);
  return result.status;
}
test('selected archive, lock and installed bytes qualify', () => fixture((project) => {
  assert.equal(check(project), 0);
  assert.equal(check(project, '--archive-only'), 0);
}));
test('missing or tampered archive refuses before dependency execution', () => fixture((project) => {
  const path = join(project, 'tools/dependency-security', archive);
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('tampered')]));
  assert.notEqual(check(project, '--archive-only'), 0);
  rmSync(path);
  assert.notEqual(check(project, '--archive-only'), 0);
}));
test('stale installed parser and symlink substitution are refused', () => fixture((project) => {
  const path = join(project, 'node_modules/picomatch/lib/parse.js');
  writeFileSync(path, 'old vulnerable parser');
  assert.notEqual(check(project), 0);
  if (process.platform === 'win32') {
    const packagePath = join(project, 'node_modules/picomatch');
    rmSync(packagePath, { recursive: true });
    symlinkSync(join(source, 'node_modules/picomatch'), packagePath, 'junction');
  } else {
    rmSync(path);
    symlinkSync(join(here, 'verify.mjs'), path);
  }
  assert.notEqual(check(project), 0);
}));
test('registry substitution, wrong integrity and a nested unchecked copy are refused', () => fixture((project) => {
  const path = join(project, 'package-lock.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  for (const fault of ['resolved', 'integrity', 'nested']) {
    const lock = structuredClone(original);
    if (fault === 'resolved') lock.packages['node_modules/picomatch'].resolved = 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz';
    if (fault === 'integrity') lock.packages['node_modules/picomatch'].integrity = 'sha512-other';
    if (fault === 'nested') lock.packages['node_modules/vite/node_modules/picomatch'] = lock.packages['node_modules/picomatch'];
    writeFileSync(path, JSON.stringify(lock));
    assert.notEqual(check(project, '--archive-only'), 0);
  }
}));
test('an unrecorded installed transitive copy is refused', () => fixture((project) => {
  const nested = join(project, 'node_modules/vite/node_modules/picomatch');
  cpSync(join(project, 'node_modules/picomatch'), nested, { recursive: true });
  assert.notEqual(check(project), 0);
}));
test('production reification must omit the development matcher', () => fixture((project) => {
  assert.notEqual(check(project, '--production'), 0);
  rmSync(join(project, 'node_modules/picomatch'), { recursive: true });
  assert.equal(check(project, '--production'), 0);
}));
test('backend and frontend context bytes stay identical', () => {
  const result = spawnSync(process.execPath, [join(here, 'sync-mirrors.mjs')], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0);
});
test('owned development commands refuse stale installs before toolchain execution', () => {
  for (const name of ['backend', 'frontend']) {
    const project = resolve(source, '..', name);
    const { scripts } = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    for (const command of ['dev', 'build', 'test', 'lint', 'typecheck', 'test:watch', 'test:e2e', 'preview'])
      if (command in scripts)
        assert.equal(scripts['pre' + command], 'node tools/dependency-security/verify.mjs');
  }
});
