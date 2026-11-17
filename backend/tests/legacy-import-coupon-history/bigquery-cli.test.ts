import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
async function run(input: string, args = ['--seal-candidate']) {
  return new Promise<{ code: number | null; out: string; error: string }>((resolve, reject) => {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tools/legacy-import-coupon-history/seal-publication.ts', ...args],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CSV_COUPON_SOURCE_PROOF_KEY: 'synthetic-source-key-for-private-cli-'.repeat(2),
            CSV_COUPON_PUBLICATION_KEY: 'synthetic-publication-key-for-private-cli-'.repeat(2),
            CSV_COUPON_HISTORY_KEY: 'synthetic-history-key-for-private-cli-'.repeat(2),
          },
        },
      ),
      timer = setTimeout(() => {
        child.kill();
        reject(Error('bounded CLI did not exit'));
      }, 5000);
    let out = '',
      error = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => {
      out += value;
    });
    child.stderr.on('data', (value) => {
      error += value;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, error });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
describe('read-only coupon candidate artifact CLI', () => {
  it.each(['invalid', 'oversize', 'unspecified'] as const)(
    'fails %s input statically without credentials, source content or SDK error output',
    async (kind) => {
      const canary = 'SYNTHETIC-PRIVATE-COUPON-CANARY',
        result = await run(
          kind === 'oversize' ? canary.repeat(12000) : JSON.stringify({ rawCoupon: canary }),
          kind === 'unspecified' ? [] : ['--seal-candidate'],
        );
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.error).toBe(
        JSON.stringify({ resource: 'csv-coupon-publication', code: 'PUBLICATION_REVIEW_FAILED' }) +
          '\n',
      );
      expect(result.error).not.toContain(canary);
    },
  );
});
