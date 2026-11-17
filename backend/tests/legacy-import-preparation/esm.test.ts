import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedEnvironment } from '../../tools/legacy-import-esm/check.js';

describe('source preparation native ESM startup', () => {
  it.each([
    'source-order-preparation.ts',
    'source-order-preparation-runtime.ts',
    'financial-adapter-transport.ts',
  ])(
    'imports %s in a fresh Node process with no provider/database/credential environment',
    (entry) => {
      const result = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('tools/legacy-import-esm/probe.mjs'),
          resolve('src/modules/legacy-order-imports', entry),
        ],
        {
          encoding: 'utf8',
          env: isolatedEnvironment(),
          timeout: 10000,
          maxBuffer: 16000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(result).toBe('IMPORT_OK\n');
    },
  );
});
