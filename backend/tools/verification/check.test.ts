import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runCheck } from './check.js';

function fixture(t: TestContext, source: string) {
  const workspace = mkdtempSync(join(tmpdir(), 'pos-check-executor-'));
  mkdirSync(join(workspace, 'backend/evidence/private'), { recursive: true });
  writeFileSync(join(workspace, 'backend/child.cjs'), source);
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const activeProcesses = new Set<ChildProcess>();
  return {
    workspace,
    activeProcesses,
    context: { workspace, activeProcesses, environment: { PATH: process.env.PATH } },
  };
}

test('successful child output is retained without a timeout or active process', async (t) => {
  const f = fixture(t, 'process.stdout.write("controlled output");');
  const result = await runCheck(
    { id: 'success', directory: 'backend', args: ['child.cjs'] },
    f.context,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimitExceeded, false);
  assert.equal(f.activeProcesses.size, 0);
  assert.equal(readFileSync(join(f.workspace, result.log), 'utf8'), 'controlled output');
});

test(
  'deadline permits cleanup but remains failed even when the child exits zero',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = fixture(
      t,
      `
      require('node:fs').writeFileSync('ready', 'ready');
      process.on('SIGTERM', () => {
        require('node:fs').writeFileSync('cleaned', 'cleaned');
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `,
    );
    const result = await runCheck(
      { id: 'cleanup', directory: 'backend', args: ['child.cjs'], timeoutMs: 1000 },
      f.context,
    );
    assert.equal(existsSync(join(f.workspace, 'backend/ready')), true);
    assert.equal(existsSync(join(f.workspace, 'backend/cleaned')), true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, true);
    assert.equal(f.activeProcesses.size, 0);
  },
);

test(
  'a child ignoring termination is forcibly stopped after the cleanup grace',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = fixture(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    const result = await runCheck(
      { id: 'forced', directory: 'backend', args: ['child.cjs'], timeoutMs: 1000 },
      f.context,
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationSignal, 'SIGKILL');
    assert.equal(f.activeProcesses.size, 0);
  },
);

test('excessive output is refused separately from a timeout', async (t) => {
  const f = fixture(
    t,
    `process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000);`,
  );
  const result = await runCheck(
    { id: 'output-limit', directory: 'backend', args: ['child.cjs'], timeoutMs: 10000 },
    f.context,
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.timedOut, false);
  assert.ok(readFileSync(join(f.workspace, result.log)).length <= 4 * 1024 * 1024);
  assert.equal(f.activeProcesses.size, 0);
});
