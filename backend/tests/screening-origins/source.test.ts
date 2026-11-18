import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinnedSourceEnvironment } from '../../tools/pinned-source-env.js';

describe('genuine source cart and final-order qualification', () => {
  function run(file: string) {
    const nativeUrl = process.env.ORIGIN_PREVIEW_MYSQL_TEST_URL;
    if (nativeUrl) {
      const parsed = new URL(nativeUrl);
      if (
        !['mysql:', 'mysql+pymysql:'].includes(parsed.protocol) ||
        !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
        parsed.pathname !== '/pos_rewrite_origin_preview_test' ||
        parsed.search ||
        parsed.hash
      )
        throw new Error('An explicit isolated origin preview database is required.');
    }
    const output = execFileSync(
      resolve('tools/screening-origins/run-fixture.sh'),
      ['-B', resolve('tests/screening-origins', file), '-v'],
      {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 30000,
        env: {
          ...pinnedSourceEnvironment(),
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          PYTHONDONTWRITEBYTECODE: '1',
          TZ: 'Asia/Kolkata',
          ...(nativeUrl ? { ORIGIN_PREVIEW_MYSQL_TEST_URL: nativeUrl } : {}),
        },
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
