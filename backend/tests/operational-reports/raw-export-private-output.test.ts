import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('legacy export qualification private-output boundary', () => {
  it('prints only static stage/code for a credential-bearing unknown SDK error before credential/client access', () => {
    const result = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'tools/operational-reports/validate-bigquery-raw.ts'],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          REPORT_EXPORT_DIAGNOSTIC_FIXTURE: 'credential-error',
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      JSON.stringify({
        resource: 'legacy-report-export-validation',
        stage: 'synthetic-private-error',
        code: 'VALIDATION_FAILED',
      }) + '\n',
    );
    for (const secret of [
      'synthetic-secret',
      'Bearer',
      'authorization',
      'request',
      'response',
      'cause',
      '400',
    ])
      expect(result.stdout + result.stderr).not.toContain(secret);
  }, 20000);
});
