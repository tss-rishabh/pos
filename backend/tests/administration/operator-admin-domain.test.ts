import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  administrationUsername,
  administrationWallTimestamp,
  operatorAdminProfileInput,
} from '../../src/modules/administration/operator-admin-domain.js';

it('matches pinned native Django Unicode UsernameField validation and NFKC normalization', () => {
  const oracle = z
    .object({
      usernameCases: z
        .array(z.object({ input: z.string(), valid: z.boolean(), value: z.string().optional() }))
        .min(16),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL('../../parity/administration-access-oracle.json', import.meta.url),
          'utf8',
        ),
      ) as unknown,
    );
  for (const example of oracle.usernameCases) {
    const actual = administrationUsername.safeParse(example.input);
    expect(actual.success).toBe(example.valid);
    if (actual.success) expect(actual.data).toBe(example.value);
  }
});
it('preserves source naive wall values and microseconds while rejecting timezone shifts and invalid calendar dates', () => {
  for (const value of ['2000-02-29 01:02:03', '2026-11-16 23:59:59.123456', '1000-01-01 00:00:00'])
    expect(administrationWallTimestamp.parse(value)).toBe(value);
  expect(administrationWallTimestamp.parse('2026-11-16T23:59:59.123456')).toBe(
    '2026-11-16 23:59:59.123456',
  );
  for (const value of [
    '2001-02-29 01:02:03',
    '2026-11-16 24:00:00',
    '2026-11-16 23:59:60',
    '2026-11-16T12:00:00Z',
    '2026-11-16T12:00:00+05:30',
    '0000-01-01 00:00:00',
  ])
    expect(administrationWallTimestamp.safeParse(value).success).toBe(false);
  expect(
    operatorAdminProfileInput.safeParse({ mfaHash: 'must-never-be-a-profile-field' }).success,
  ).toBe(false);
});
