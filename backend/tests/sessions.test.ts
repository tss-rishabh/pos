import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { redisSessions, type SessionAccount } from '../src/auth/sessions.js';
import { memoryRedisPort } from './helpers/memory-redis.js';
import { appStack, appStackMysqlUrl, appStackOperator } from './helpers/app-stack.js';
import {
  singleAccountReader,
  syntheticOperator,
  syntheticSessionAccount,
} from './helpers/principals.js';

describe('revocable server sessions', () => {
  it.skipIf(!appStackMysqlUrl)(
    'revokes stolen-cookie replay on logout',
    async () => {
      const stack = await appStack(),
        { app } = stack;
      try {
        const cookie = await stack.cookie(appStackOperator.id);
        expect((await app.inject({ url: '/api/v1/stores', headers: { cookie } })).statusCode).toBe(
          200,
        );
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: '/api/v1/auth/sessions/current',
              headers: { cookie, origin: stack.origin },
            })
          ).statusCode,
        ).toBe(204);
        expect((await app.inject({ url: '/api/v1/stores', headers: { cookie } })).statusCode).toBe(
          401,
        );
      } finally {
        await stack.close();
      }
    },
    60_000,
  );
  it('checks actor/secret binding and revocation', async () => {
    const config = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'revocation-test-fixture-'.repeat(3),
    });
    const redis = memoryRedisPort(),
      service = redisSessions(config, singleAccountReader(), redis),
      credential = await service.create(syntheticOperator.id);
    expect(await service.valid(syntheticOperator.id, credential)).toBe(true);
    expect(await service.valid('2', credential)).toBe(false);
    expect(
      await service.valid(syntheticOperator.id, { ...credential, secret: 'x'.repeat(43) }),
    ).toBe(false);
    expect(await service.alive(credential.sessionId, syntheticOperator.id)).toBe(true);
    await service.revoke(credential.sessionId);
    expect(await service.valid(syntheticOperator.id, credential)).toBe(false);
  });
  it('stores only hashes, expires at end of day, and follows the password hash', async () => {
    let clock = Date.UTC(2026, 10, 19, 4, 30, 0);
    const redis = memoryRedisPort(() => clock);
    let row: SessionAccount | undefined = {
      ...syntheticSessionAccount(),
      password: 'pbkdf2_sha256$600000$a$b',
    };
    const service = redisSessions(
      {
        SESSION_SECRET: 'session-hash-fixture-secret-'.repeat(2),
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      },
      async () => (row ? { ...row } : undefined),
      redis,
      () => clock,
    );
    const credential = await service.create(syntheticOperator.id);
    expect(credential.expires - clock).toBe((14 * 3600 - 1) * 1000);
    const [key] = redis.keys();
    expect(key).toBe(`pos:session:${credential.sessionId}`);
    const value = redis.peek(key!)!;
    expect(value).not.toContain(credential.secret);
    expect(value).not.toContain(row.password);
    row = { ...row, password: 'pbkdf2_sha256$600000$a$c' };
    expect(await service.valid(syntheticOperator.id, credential)).toBe(false);
    await service.refreshPasswordHash(credential.sessionId, row.password);
    expect(await service.valid(syntheticOperator.id, credential)).toBe(true);
    clock += 14 * 3600 * 1000;
    expect(await service.valid(syntheticOperator.id, credential)).toBe(false);
    expect(redis.keys()).toEqual([]);
  });
});
