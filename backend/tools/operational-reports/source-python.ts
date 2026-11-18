import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const runtime = z.object({
  implementation: z.literal('cpython'),
  major: z.literal(3),
  minor: z.literal(10),
});
const verified = new Set<string>();
/** Source Dockerfile and Dockerfile.celery explicitly select CPython3.10, including float sum semantics. */
export function sourcePython310(): string {
  const executable =
    process.env.POS_OPERATIONAL_SOURCE_PYTHON ||
    fileURLToPath(
      new URL(
        process.platform === 'win32'
          ? '../inventory-workbooks/.venv/Scripts/python.exe'
          : '../inventory-workbooks/.venv/bin/python',
        import.meta.url,
      ),
    );
  if (verified.has(executable)) return executable;
  if (!existsSync(executable))
    throw new Error(
      'POS source oracles require the caller-owned workbook CPython3.10 environment or POS_OPERATIONAL_SOURCE_PYTHON pointing to CPython3.10.',
    );
  let version: unknown;
  try {
    version = JSON.parse(
      execFileSync(
        executable,
        [
          '-I',
          '-B',
          '-c',
          'import json,sys; print(json.dumps(dict(implementation=sys.implementation.name,major=sys.version_info.major,minor=sys.version_info.minor)))',
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ) as unknown;
  } catch {
    throw new Error(
      'The configured source-oracle interpreter could not be validated as CPython3.10.',
    );
  }
  if (!runtime.safeParse(version).success)
    throw new Error(
      'POS source oracles require CPython3.10; ambient newer float-sum behavior is not the pinned deployment contract.',
    );
  verified.add(executable);
  return executable;
}
/** Keep each caller's input, deadline, exact JSON assertions and buffer limits; never write bytecode. */
export function executePosSourceOracle(
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string {
  return execFileSync(sourcePython310(), ['-B', ...args], options);
}
