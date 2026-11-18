import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Check = {
  id: string;
  directory: 'backend' | 'frontend';
  command?: 'sh';
  args: string[];
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  prerequisite?: boolean;
};
export type CheckResult = {
  id: string;
  exitCode: number;
  durationMs: number;
  log: string;
  terminationSignal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
};
export type CheckContext = {
  workspace: string;
  environment: NodeJS.ProcessEnv;
  activeProcesses: Set<ChildProcess>;
};

export function stopProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* The child can finish between checking its PID and signalling it. */
  }
}
export async function runCheck(check: Check, context: CheckContext): Promise<CheckResult> {
  const { workspace, activeProcesses } = context;
  const started = performance.now(),
    output: Buffer[] = [];
  let bytes = 0,
    exceeded = false,
    timedOut = false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(check.command ?? process.execPath, check.args, {
    cwd: resolve(workspace, check.directory),
    env: { ...context.environment, ...check.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  activeProcesses.add(child);
  const terminate = () => {
    stopProcess(child, 'SIGTERM');
    // Shell traps can remove owned Docker fixtures before forced termination.
    forceStop ??= setTimeout(() => stopProcess(child, 'SIGKILL'), 5000);
  };
  const collect = (value: Buffer) => {
    bytes += value.length;
    if (bytes <= 4 * 1024 * 1024) output.push(value);
    else if (!exceeded) {
      exceeded = true;
      terminate();
    }
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const timeout = setTimeout(
    () => {
      timedOut = true;
      terminate();
    },
    check.timeoutMs ?? 10 * 60 * 1000,
  );
  let terminationSignal: NodeJS.Signals | null = null;
  const code = await new Promise<number>((done) => {
    child.once('error', () => done(1));
    child.once('close', (exitCode, signal) => {
      terminationSignal = signal;
      done(exitCode ?? 1);
    });
  });
  clearTimeout(timeout);
  if (forceStop) clearTimeout(forceStop);
  activeProcesses.delete(child);
  const log = `backend/evidence/private/verification-${check.id}.log`;
  writeFileSync(resolve(workspace, log), Buffer.concat(output), { mode: 0o600 });
  const result = {
    id: check.id,
    exitCode: exceeded || timedOut ? 1 : code,
    durationMs: Math.round(performance.now() - started),
    log,
    terminationSignal,
    timedOut,
    outputLimitExceeded: exceeded,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}
