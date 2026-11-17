import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('private source runtime effect and resource oracles', () => {
  for (const file of [
    'test_effects.py',
    'test_publication_resource.py',
    'test_catalog_pipeline.py',
  ])
    it(`executes ${file} without broker/provider I/O`, () => {
      const output = execFileSync(
        resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
        ['-B', resolve('tools/source-runtime-acceptance', file)],
        {
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 20000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      );
      expect(output).not.toContain('private@example.test');
    });
});
