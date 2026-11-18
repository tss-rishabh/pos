import { expect, it } from 'vitest';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';
it('executes the pinned original fast cash helper and verifies portable vectors without writing', () => {
  const result = z
    .object({
      sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
      sourceFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
      cases: z.literal(17),
    })
    .strict()
    .parse(JSON.parse(goldenStdout('checkout', 'fast-cash-source')) as unknown);
  expect(result.cases).toBe(17);
});
