import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { redisSessions, type SessionAccount } from '../src/auth/sessions.js';
import { memoryRedisPort } from '../src/redis/memory.js';
import { demoAccountReader } from '../src/auth/demo-session.js';
import { demoUser } from '../src/modules/demo.js';

describe('revocable server sessions', () => {
  it('revokes stolen-cookie replay on logout and checks actor/secret binding', async () => {
    const app = await buildApp(
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'revocation-test-fixture-'.repeat(3),
      }),
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/demo-sessions',
        headers: { origin: 'http://localhost:5173' },
      });
      const cookie = response.cookies[0]!.name + '=' + response.cookies[0]!.value;
      expect((await app.inject({ url: '/api/v1/stores', headers: { cookie } })).statusCode).toBe(
        200,
      );
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/v1/auth/sessions/current',
            headers: { cookie, origin: 'http://localhost:5173' },
          })
        ).statusCode,
      ).toBe(204);
      expect((await app.inject({ url: '/api/v1/stores', headers: { cookie } })).statusCode).toBe(
        401,
      );
    } finally {
      await app.close();
    }
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'revocation-test-fixture-'.repeat(3),
    });
    const redis = memoryRedisPort(),
      service = redisSessions(config, demoAccountReader(demoUser), redis),
      credential = await service.create(demoUser.id);
    expect(await service.valid(demoUser.id, credential)).toBe(true);
    expect(await service.valid('2', credential)).toBe(false);
    expect(await service.valid(demoUser.id, { ...credential, secret: 'x'.repeat(43) })).toBe(false);
    expect(await service.alive(credential.sessionId, demoUser.id)).toBe(true);
    await service.revoke(credential.sessionId);
    expect(await service.valid(demoUser.id, credential)).toBe(false);
  });
  it('stores only hashes, expires at end of day, and follows the password hash', async () => {
    let clock = Date.UTC(2026, 10, 19, 4, 30, 0);
    const redis = memoryRedisPort(() => clock);
    let row: SessionAccount | undefined = {
      ...(await demoAccountReader(demoUser)(demoUser.id))!,
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
    const credential = await service.create(demoUser.id);
    expect(credential.expires - clock).toBe((14 * 3600 - 1) * 1000);
    const [key] = redis.keys();
    expect(key).toBe(`pos:session:${credential.sessionId}`);
    const value = redis.peek(key!)!;
    expect(value).not.toContain(credential.secret);
    expect(value).not.toContain(row.password);
    row = { ...row, password: 'pbkdf2_sha256$600000$a$c' };
    expect(await service.valid(demoUser.id, credential)).toBe(false);
    await service.refreshPasswordHash(credential.sessionId, row.password);
    expect(await service.valid(demoUser.id, credential)).toBe(true);
    clock += 14 * 3600 * 1000;
    expect(await service.valid(demoUser.id, credential)).toBe(false);
    expect(redis.keys()).toEqual([]);
  });
});
