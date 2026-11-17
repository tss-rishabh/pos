import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('prints only traced static diagnostics when a credential-bearing fixture URL is refused', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    CHECKOUT_MYSQL_TEST_URL:
      'mysql://private-user:private-token@not-local.example.test/private-database',
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC'])
    if (process.env[key]) env[key] = process.env[key];
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'tools/legacy-import-benefits/query-proposal.ts'],
    { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toMatch(
    /private-user|private-token|not-local|private-database|password|stack|cause|mysql:\/\//i,
  );
  const event: unknown = JSON.parse(result.stderr);
  expect(event).toMatchObject({
    module: 'legacy-order-imports',
    resource: 'benefit-query-proposal',
    userId: null,
    eventId: 'legacy-order-imports.benefit-query-proposal.failed',
    code: 'BENEFIT_QUERY_PROPOSAL_FAILED',
  });
});
