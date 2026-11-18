import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('genuine source cart and final-order qualification', () => {
  function run(file: string) {
    const output = execFileSync(
      resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
      ['-B', resolve('tests/screening-origins', file), '-v'],
      {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 30000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TZ: 'Asia/Kolkata' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(output).toBe('');
  }

  it('executes current-control WSGI and disabled supervised-worker boundaries', () => {
    run('test_resources.py');
  });

  it.skipIf(!process.env.ORIGIN_PREVIEW_MYSQL_TEST_URL)(
    'executes pinned Cart/Order/PosOrder/auth/CSK paths against disposable native fixtures',
    () => run('test_preview.py'),
    60000, // One Python invocation owns nineteen separate disposable schemas.
  );
});
