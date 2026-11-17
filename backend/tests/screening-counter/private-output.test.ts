import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('screening counter metadata private output', () => {
  it('never serializes credential-bearing SDK exceptions', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'tools/screening-counter/discover.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH, SCREENING_COUNTER_DIAGNOSTIC_FIXTURE: 'credential-error' },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr) as unknown).toEqual({
      resource: 'screening-counter-metadata',
      stage: 'synthetic-private-error',
      code: 'METADATA_FAILED',
    });
    expect(result.stderr).not.toMatch(
      /Bearer|synthetic-private-(?:message|bearer|body|header|cause)/,
    );
  });
});
