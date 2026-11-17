import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('shared diagnostic private-output boundary for full order search', () => {
  it('does not serialize a credential-bearing SDK exception in the new validation group', () => {
    const result = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'tools/order-history/bigquery.ts'],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          ORDER_HISTORY_VALIDATION_GROUP: 'source-order-search',
          ORDER_HISTORY_DIAGNOSTIC_FIXTURE: 'credential-error',
          BQ_ORDER_HISTORY_VALIDATION_KEY_FILE: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      JSON.stringify({
        resource: 'public-order-history',
        stage: 'synthetic-private-error',
        code: 'VALIDATION_FAILED',
      }) + '\n',
    );
    for (const value of [
      'synthetic-secret',
      'Bearer',
      'authorization',
      'request',
      'response',
      'cause',
    ])
      expect(result.stdout + result.stderr).not.toContain(value);
  }, 20000);
});
