import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('invocation-local source benefit qualification', () => {
  it.each(['test_fence.py', 'test_runtime.py', 'test_free_gst.py'])(
    'executes pinned source/current-query/capability controls without services: %s',
    (file) => {
      const output = execFileSync(
        resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
        ['-B', resolve('tools/legacy-import-benefits', file), '-v'],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 16000,
          env: {
            ...process.env,
            POS_LEGACY_IMPORT_SOURCE_ROOT:
              process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(output).toBe('');
    },
  );
});
