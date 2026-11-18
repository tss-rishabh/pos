/** Read-only review of one immutable PUBLIC upstream proposal, not an install. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(process.argv[2] ?? join(here, '../../..'));
const original = join(project, 'backend/node_modules/picomatch');
const response = await fetch(
  'https://raw.githubusercontent.com/handeyman/picomatch/c63a5bf4e61dbdb81bc41e97dc2616c30acce337/lib/parse.js',
  {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  },
);
if (!response.ok) throw new Error('Pinned upstream proposal unavailable');
const parts = [];
let bytes = 0;
for await (const part of response.body) {
  bytes += part.length;
  if (bytes > 262144) throw new Error('Upstream source bound');
  parts.push(part);
}
const parser = Buffer.concat(parts);
assert.equal(
  createHash('sha1')
    .update(Buffer.from(`blob ${parser.length}\0`))
    .update(parser)
    .digest('hex'),
  '379ea41bae6ca13a855d4687b6d50e28dc79faff',
  'Pinned upstream Git blob changed',
);
const directory = mkdtempSync(join(tmpdir(), 'pos-picomatch-pr254-'));
try {
  const upstream = JSON.parse(readFileSync(join(here, 'upstream-files.json'), 'utf8'));
  for (const file of upstream.files) {
    const input = readFileSync(join(original, file.path));
    assert.equal(createHash('sha256').update(input).digest('hex'), file.sha256);
    mkdirSync(dirname(join(directory, file.path)), { recursive: true });
    writeFileSync(join(directory, file.path), file.path === 'lib/parse.js' ? parser : input);
  }
  function run(module, pattern, subject) {
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=128', join(here, 'child.cjs')],
      {
        input: JSON.stringify({ action: 'match', module, pattern, subject, options: {} }),
        encoding: 'utf8',
        timeout: 1500,
        killSignal: 'SIGKILL',
        maxBuffer: 64000,
        env: { PATH: process.env.PATH, TZ: 'UTC' },
      },
    );
    if (result.error?.code === 'ETIMEDOUT') return { deadline: true };
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout);
  }
  const pattern = '+([a/]*)',
    subject = 'a/a';
  const before = run(original, pattern, subject),
    after = run(directory, pattern, subject);
  assert.equal(before.result, true);
  assert.equal(after.result, false);
  const unresolved = run(directory, '+(*a|*b)', 'a'.repeat(28) + '/');
  assert.equal(unresolved.deadline, true);
  process.stdout.write(
    `${JSON.stringify({
      proposal: 254,
      commit: 'c63a5bf4e61dbdb81bc41e97dc2616c30acce337',
      separatorCounterexample: {
        pattern,
        subject,
        original: before.result,
        proposal: after.result,
      },
      multiBranchDeadline: true,
      acceptedAsDropIn: false,
    })}\n`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
