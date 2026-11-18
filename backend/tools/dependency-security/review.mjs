/** Bounded public-package checks; no project dependency activation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(process.argv[2] ?? join(here, '../../..'));
const original = join(project, 'backend/node_modules/picomatch');
const checksum = (value) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
assert.equal(checksum(readFileSync(join(here, manifest.archive.path))), manifest.archive.sha256);
const temporary = mkdtempSync(join(tmpdir(), 'pos-picomatch-check-'));
const candidate = join(temporary, 'package');
try {
  execFileSync('tar', ['-xzf', join(here, manifest.archive.path), '-C', temporary], {
    stdio: 'pipe',
  });
  for (const file of manifest.files) {
    assert.equal(checksum(readFileSync(join(candidate, file.path))), file.candidateSha256);
    assert.equal(checksum(readFileSync(join(original, file.path))), file.originalSha256);
  }

  function child(request, deadline = 1500) {
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=128', join(here, 'child.cjs')],
      {
        input: JSON.stringify(request),
        encoding: 'utf8',
        timeout: deadline,
        killSignal: 'SIGKILL',
        maxBuffer: 64000,
        env: { PATH: process.env.PATH, TZ: 'UTC' },
      },
    );
    if (result.error?.code === 'ETIMEDOUT') return { deadline: true };
    if (result.status !== 0 || result.stderr) throw new Error('Isolated dependency child failed');
    return JSON.parse(result.stdout);
  }

  const hostile = ['+(*)', '+(*a)', '*(*)', '*(*a)', '+(*)a', '+(*a|*b)', '+(ab|abab)', '+(*a*a)'];
  const hostileResults = [];
  for (const pattern of hostile) {
    const subject = pattern.includes('ab|') ? 'ab'.repeat(45) + '/' : 'a'.repeat(28) + '/';
    const before = child({ action: 'match', module: original, pattern, subject, options: {} });
    const after = child({
      action: 'match',
      module: candidate,
      pattern,
      subject: pattern.includes('ab|') ? 'ab'.repeat(10000) + '/' : 'a'.repeat(10000) + '/',
      options: {},
    });
    assert.equal(after.deadline, undefined, `Candidate deadline: ${pattern}`);
    assert.equal(after.result, false, `Unexpected hostile match: ${pattern}`);
    hostileResults.push({
      pattern,
      baselineDeadline: before.deadline === true,
      baselineMilliseconds: before.milliseconds ?? null,
      candidateMilliseconds: after.milliseconds,
    });
  }
  assert(
    hostileResults.some((row) => row.baselineDeadline),
    'The pinned baseline vulnerability was not reproduced',
  );

  // Real project config string literals, plus upstream toolchain defaults. The
  // corpus contains only tracked source paths and generated fixture filenames.
  const ts = createRequire(join(project, 'backend/package.json'))('typescript');
  const tracked = execFileSync('git', ['-C', project, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 4000000,
  })
    .split('\0')
    .filter(Boolean);
  const patternSet = new Set([
    '**/*.{test,spec}.?(c|m)[jt]s?(x)',
    '**/node_modules/**',
    '**/.git/**',
    '**/*',
    '**/*.{js,ts,jsx,tsx,mjs,cjs}',
    '**/*.html',
    '**/*.vue',
    '**/*.svelte',
    '**/dist/**',
    '**/coverage/**',
    '**/test/**',
    '**/tests/**',
    'src/**/*',
  ]);
  for (const path of tracked) {
    if (
      !/^(backend|frontend)\//.test(path) ||
      !/\.(?:[cm]?js|tsx?|json)$/.test(path) ||
      !/(?:config|eslint)/i.test(path) ||
      /(?:compatibility|evidence|dist|node_modules)/.test(path)
    )
      continue;
    const text = readFileSync(join(project, path), 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (
        ts.isStringLiteralLike(node) &&
        !/[\n\r\s]/.test(node.text) &&
        (node.text.includes('**') || /\*\.[a-z{]/i.test(node.text))
      )
        patternSet.add(node.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const patterns = [...patternSet].sort();
  const subjects = [
    ...new Set([
      ...tracked
        .filter((name) => /^(backend|frontend)\//.test(name))
        .flatMap((name) => [name, name.replace(/^(backend|frontend)\//, '')]),
      '.env',
      '.hidden/test.ts',
      'src/.hidden.ts',
      'src/a.test.ts',
      'tests/a.spec.tsx',
      'src/a.test.cts',
      'src/a.spec.mjs',
      'C:\\fixture\\tests\\a.test.ts',
      'tests\\unit\\a.test.ts',
      'src/a\nb.ts',
      'src/a\rb.ts',
    ]),
  ];
  const options = [
    {},
    { dot: true },
    { windows: true },
    { nocase: true },
    { capture: true },
    { bash: true },
  ];
  const matrix = child(
    { action: 'matrix', module: original, other: candidate, patterns, subjects, options },
    45000,
  );
  assert.equal(matrix.deadline, undefined, 'Owned glob differential deadline');
  assert.deepEqual(matrix.differences, [], 'Owned build/test glob semantics changed');

  const small = ['', '.', '/', '\\', '!', '\n'];
  for (let length = 0; length <= 5; length++)
    for (let bits = 0; bits < 2 ** length; bits++) {
      let value = '';
      for (let index = 0; index < length; index++) value += bits & (1 << index) ? 'a' : 'b';
      small.push(value, value + '/', '.' + value);
    }
  const linear = child(
    {
      action: 'matrix',
      module: original,
      other: candidate,
      sourceEquality: false,
      patterns: [
        '+(*)',
        '+(*a)',
        '*(*)',
        '*(*a)',
        '+(*)a',
        'a+(b*)c',
        '+(ab*ba)',
        '*(*?a)',
        '+(a?*)',
        '+(a|b)',
      ],
      subjects: small,
      options: options.filter((option) => !option.bash),
    },
    10000,
  );
  assert.equal(linear.deadline, undefined);
  assert.deepEqual(
    linear.differences,
    [],
    'Qualified linearization changed short-input match semantics',
  );

  // Explicitly unsupported ambiguous/nested forms are literalized, not silently
  // accepted as a general regex sandbox. Opting out cannot restore the bomb.
  for (const pattern of ['+(*a|*b)', '+(ab|abab)', '+([a/]*)', '+(*a*a)', '+(+(a*))']) {
    const result = child({
      action: 'match',
      module: candidate,
      pattern,
      subject: pattern,
      options: { maxExtglobRecursion: false },
    });
    assert.equal(result.deadline, undefined);
    assert.equal(result.result, true);
    assert.equal(result.regexResult, true);
    assert(result.source.includes('\\+\\('), 'Unsupported repetition was not literalized');
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        contract: manifest.contract,
        activated: false,
        node: process.version,
        parserSha256: manifest.files.find((file) => file.path === 'lib/parse.js').candidateSha256,
        hostileResults,
        ownedPatterns: patterns.length,
        ownedSubjects: subjects.length,
        ownedRegexSources: matrix.sources,
        ownedMatchPairs: matrix.pairs,
        linearizationPairs: linear.pairs,
        differences: 0,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
