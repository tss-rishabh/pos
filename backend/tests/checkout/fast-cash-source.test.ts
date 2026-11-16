import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { z } from 'zod';
it('executes the pinned original fast cash helper and verifies portable vectors without writing', () => {
  const result = z
    .object({
      sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
      sourceFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
      cases: z.literal(17),
    })
    .strict()
    .parse(
      JSON.parse(
        execFileSync('python3', ['tools/checkout/fast_cash_oracle.py'], {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 4096,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      ) as unknown,
    );
  expect(result.cases).toBe(17);
});
