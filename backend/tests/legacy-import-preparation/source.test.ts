import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('pinned Python source preparation control flow', () => {
  function run(environment: NodeJS.ProcessEnv) {
    const output = execFileSync(
      resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
      ['-B', resolve('tools/legacy-import-preparation/test_source.py'), '-v'],
      {
        encoding: 'utf8',
        maxBuffer: 16000,
        env: {
          ...process.env,
          POS_LEGACY_IMPORT_SOURCE_ROOT:
            process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
          ...environment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(output).toBe('');
  }
  it('executes literal eligibility, clock, alias-fence, concurrency and HTTP cases with no services', () => {
    run({ SOURCE_PREPARATION_SKIP_MATRIX: 'true' });
  });
  it.each(['plain', 'app-percent', 'birthday-percent', 'birthday-zero', 'gst', 'gst-birthday'])(
    'matches qualified-original batching in14cart/history vectors and28 HP/refund comparisons: %s',
    (profile) => {
      const profiles = [
        'plain',
        'app-percent',
        'birthday-percent',
        'birthday-zero',
        'gst',
        'gst-birthday',
      ];
      run({
        SOURCE_PREPARATION_MATRIX_ONLY: 'true',
        SOURCE_PREPARATION_MATRIX_PROFILE: String(profiles.indexOf(profile)),
      });
    },
  );
});
