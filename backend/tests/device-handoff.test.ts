import { createHash } from 'node:crypto';
import { Secret } from 'otpauth';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../src/config.js';
import { createDatabases } from '../src/db/pools.js';
import {
  deviceHandoffOptions,
  deviceHandoffService,
  deviceHandoffVerification,
  handoffTotp,
} from '../src/auth/device-handoff.js';
import { assertRedisUrl } from '../src/redis/node-client.js';
import { demoUser } from '../src/modules/demo.js';
import { goldenStdout } from './golden/load.js';

it('matches the actual source QR TOTP verifier, rotation and TTL across secret and interval boundaries', () => {
  const cases: { secret: string; period: number; timestamp: number; code?: string }[] = [];
  for (const period of [30, 60, 120, 300])
    for (const timestamp of [1794787199999, 1794787200000, 1794787200001]) {
      // Fixed per-vector secrets keep the captured source-oracle input stable.
      const secret = Secret.fromHex(
        createHash('sha256')
          .update(`handoff-golden-${period}-${timestamp}`)
          .digest('hex')
          .slice(0, 40),
      ).base32;
      cases.push({ secret, period, timestamp });
      cases.push({
        secret,
        period,
        timestamp,
        code: handoffTotp(secret, period, timestamp - period * 1000),
      });
    }
  const oracle = z
    .array(
      z.object({
        code: z.string(),
        accepted: z.boolean(),
        rotated: z.boolean(),
        ttl: z.number().nullable(),
      }),
    )
    .parse(JSON.parse(goldenStdout('core', 'device-handoff', JSON.stringify(cases))) as unknown);
  expect(oracle).toHaveLength(cases.length);
  for (const [index, entry] of cases.entries()) {
    expect(handoffTotp(entry.secret, entry.period, entry.timestamp)).toBe(oracle[index]!.code);
    const accepted = entry.code === undefined || entry.code === oracle[index]!.code;
    expect(oracle[index]).toMatchObject({
      accepted,
      rotated: accepted,
      ttl: accepted ? 1800 : null,
    });
  }
});
it('requires a trusted service key and verified contract, and rejects plaintext remote cache configurations', async () => {
  const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'handoff-private-test-secret-'.repeat(3),
    }),
    db = createDatabases(config),
    service = deviceHandoffService(config, db, deviceHandoffOptions({}), undefined, {
      authenticate: async () => null,
    });
  expect(service.capabilities(demoUser).available).toBe(false);
  for (const key of [undefined, [], {}, 'invalid'])
    expect(() => service.authorizeService(key)).toThrow('Service authentication');
  await expect(service.issue(demoUser)).rejects.toMatchObject({
    code: 'DEVICE_HANDOFF_UNAVAILABLE',
  });
  for (const url of [
    'redis://remote.example.test/0',
    'rediss://remote.example.test/1',
    'rediss://remote.example.test/0?db=1',
    'rediss://remote.example.test/0#fragment',
  ])
    expect(() => assertRedisUrl(url, 'test')).toThrow('POS authentication Redis');
  // legacy MPosLogin also accepts email + password without a code.
  expect(
    deviceHandoffVerification.parse({ email: 'fixture@example.test', password: 'password-only' }),
  ).toMatchObject({ password: 'password-only' });
  expect(() => deviceHandoffVerification.parse({ email: 'fixture@example.test' })).toThrow();
  expect(() =>
    deviceHandoffVerification.parse({
      email: 'fixture@example.test',
      code: '123456',
      userId: '102',
    }),
  ).toThrow();
  await db.close();
});
