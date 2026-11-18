/** Install only public fixture dependencies into an isolated temporary cache. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
assert.equal(
  createHash('sha256')
    .update(readFileSync(join(here, manifest.archive.path)))
    .digest('hex'),
  manifest.archive.sha256,
);
const directory = mkdtempSync(join(tmpdir(), 'pos-picomatch-install-'));
const environment = { PATH: process.env.PATH, npm_config_cache: join(directory, 'cache') };
try {
  writeFileSync(join(directory, 'user.npmrc'), '');
  writeFileSync(join(directory, 'global.npmrc'), '');
  const packageFile = join(directory, 'package.json');
  writeFileSync(
    packageFile,
    JSON.stringify({
      name: 'private-pos-picomatch-review',
      version: '0.0.0',
      private: true,
      devDependencies: {
        picomatch: `file:${join(here, manifest.archive.path)}`,
        tinyglobby: '0.2.17',
        fdir: '6.5.0',
      },
      overrides: { picomatch: '$picomatch' },
    }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      `--userconfig=${join(directory, 'user.npmrc')}`,
      `--globalconfig=${join(directory, 'global.npmrc')}`,
    ],
    {
      cwd: directory,
      env: environment,
      stdio: 'pipe',
      timeout: 45000,
      maxBuffer: 16000,
    },
  );
  const require = createRequire(packageFile);
  const parser = readFileSync(require.resolve('picomatch/lib/parse.js'));
  assert.equal(
    createHash('sha256').update(parser).digest('hex'),
    manifest.files.find((file) => file.path === 'lib/parse.js').candidateSha256,
  );
  const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  assert.equal(
    Object.keys(lock.packages).filter((name) => /node_modules\/picomatch$/.test(name)).length,
    1,
  );
  const fixture = join(directory, 'fixture');
  for (const path of [
    'src/a.test.ts',
    'src/b.spec.tsx',
    'src/.hidden.test.ts',
    'src/a.txt',
    'node_modules/private.test.ts',
    '.git/private.test.ts',
  ]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), 'fixture');
  }
  const { globSync } = require('tinyglobby');
  assert.deepEqual(
    globSync('**/*.{test,spec}.?(c|m)[jt]s?(x)', {
      cwd: fixture,
      dot: true,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    }).sort(),
    ['src/.hidden.test.ts', 'src/a.test.ts', 'src/b.spec.tsx'],
  );
  process.stdout.write(
    `${JSON.stringify({
      installedInProject: false,
      isolatedInstall: true,
      candidateVersion: require('picomatch/package.json').version,
      tinyglobby: lock.packages['node_modules/tinyglobby'].version,
      fdir: lock.packages['node_modules/fdir'].version,
      dedupedPicomatchCopies: 1,
      discoveredFixtureTests: 3,
    })}\n`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
