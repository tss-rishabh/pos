/** Review candidate only. Never modifies an installed package or lockfile. */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? join(here, '../../node_modules/picomatch'));
const archive = 'picomatch-4.0.7-pos-review.tgz';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const original = readFileSync(join(source, 'lib/parse.js'), 'utf8');
if (sha(original) !== '4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4') {
  throw new Error('Expected the exact reviewed npm picomatch 4.0.7 parser');
}
const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
if (metadata.name !== 'picomatch' || metadata.version !== '4.0.7' || metadata.license !== 'MIT') {
  throw new Error('Unexpected source package identity');
}
const upstream = JSON.parse(readFileSync(join(here, 'upstream-files.json'), 'utf8'));
for (const file of upstream.files) {
  if (sha(readFileSync(join(source, file.path))) !== file.sha256) {
    throw new Error('Installed file differs from the integrity-verified npm archive');
  }
}
const needle = '    const analysis = analyzeRepeatedExtglob(body, opts);';
if (original.split(needle).length !== 2) throw new Error('Parser insertion boundary changed');
const insertion = readFileSync(join(here, 'repeated-extglob-guard.inc'), 'utf8').trimEnd();
let patched = original.replace(needle, `${needle}\n${insertion}`);
const close = "    let output = token.close + (opts.capture ? ')' : '');";
if (patched.split(close).length !== 2) throw new Error('Parser close boundary changed');
patched = patched.replace(
  close,
  "    let output = (singleWildcard ? (token.type === 'star' ? ')?' : ')') : token.close) + (opts.capture ? ')' : '');",
);

const files = upstream.files.map((file) => file.path);
const hashes = [];
const temporary = mkdtempSync(join(tmpdir(), 'pos-picomatch-review-'));
const destination = join(temporary, 'package');
try {
  for (const file of files) {
    const input = readFileSync(join(source, file));
    const output = file === 'lib/parse.js' ? Buffer.from(patched) : input;
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    writeFileSync(join(destination, file), output);
    utimesSync(join(destination, file), 0, 0);
    hashes.push({ path: file, originalSha256: sha(input), candidateSha256: sha(output) });
  }
  execFileSync('tar', ['-czf', join(here, archive), '-C', temporary, 'package'], { stdio: 'pipe' });
  writeFileSync(join(here, 'LICENSE.picomatch'), readFileSync(join(source, 'LICENSE')));
  writeFileSync(join(temporary, 'upstream-parse.js'), original);
  const patch = spawnSync(
    'diff',
    [
      '-u',
      '--label',
      'a/lib/parse.js',
      '--label',
      'b/lib/parse.js',
      join(temporary, 'upstream-parse.js'),
      join(destination, 'lib/parse.js'),
    ],
    { encoding: 'utf8' },
  );
  if (patch.status !== 1 || !patch.stdout || patch.stderr)
    throw new Error('Candidate source diff failed');
  writeFileSync(join(here, 'candidate.patch'), patch.stdout);
  writeFileSync(
    join(here, 'manifest.json'),
    `${JSON.stringify(
      {
        contract: 'pos-picomatch-review-candidate-v1',
        activated: false,
        base: {
          name: metadata.name,
          version: metadata.version,
          license: metadata.license,
          npmIntegrity:
            'sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==',
        },
        advisory: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
        linearizationReference:
          'https://github.com/micromatch/picomatch/pull/254/commits/c63a5bf4e61dbdb81bc41e97dc2616c30acce337',
        changedFiles: ['lib/parse.js'],
        patchSha256: sha(patch.stdout),
        archive: { path: archive, sha256: sha(readFileSync(join(here, archive))) },
        files: hashes,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ stage: 'prepared', files: files.length, parserSha256: sha(patched), activated: false })}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
