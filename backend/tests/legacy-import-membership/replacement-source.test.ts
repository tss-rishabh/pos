import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('literal source membership replacement and tender admission', () => {
  it('executes the pinned cart/removal/calculator with synthetic current catalog and stock', () => {
    const output = execFileSync(
      resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
      ['-B', resolve('tools/legacy-import-membership/test_replacement.py'), '-v'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 32_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          POS_LEGACY_IMPORT_SOURCE_ROOT:
            process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(output).toBe('');
  });
});
