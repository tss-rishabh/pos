import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertRedisUrl, setArguments } from '../../src/redis/node-client.js';
import { loginOtpState } from '../../src/auth/login-otp.js';
import { pendingLogins } from '../../src/auth/login-pending.js';
import { authRedisBackends } from '../helpers/auth-redis.js';

describe('Redis connection rules', () => {
  it('accepts database 0 only, and TLS for remote hosts', () => {
    expect(() => assertRedisUrl('redis://127.0.0.1:6379/0', 'production')).not.toThrow();
    expect(() => assertRedisUrl('rediss://cache.example.test:6380', 'production')).not.toThrow();
    for (const url of [
      'redis://cache.example.test/0',
      'rediss://cache.example.test/1',
      'rediss://cache.example.test/0?db=1',
      'http://127.0.0.1/0',
      'not a url',
    ])
      expect(() => assertRedisUrl(url, 'test')).toThrow('POS authentication Redis');
    expect(setArguments('k', 'v', { NX: true, EX: 30 })).toEqual([
      'SET',
      'k',
      'v',
      'NX',
      'EX',
      '30',
    ]);
    expect(setArguments('k', 'v', { XX: true, KEEPTTL: true })).toEqual([
      'SET',
      'k',
      'v',
      'XX',
      'KEEPTTL',
    ]);
  });
});
describe.each(authRedisBackends)('auth Redis commands on $name', (backend) => {
  let redis: Awaited<ReturnType<typeof backend.open>>;
  beforeAll(async () => {
    redis = await backend.open();
  });
  afterAll(async () => {
    await redis.close();
  });
  beforeEach(async () => {
    await redis.flush();
  });
  it('implements SET NX/XX/EX/KEEPTTL, MULTI INCR windows, lists and SCAN like Redis', async () => {
    const { port } = redis;
    expect(await port.set('a', '1', { NX: true, EX: 30 })).toBe(true);
    expect(await port.set('a', '2', { NX: true, EX: 30 })).toBe(false);
    expect(await port.set('missing', '2', { XX: true })).toBe(false);
    expect(await port.set('a', '3', { XX: true, KEEPTTL: true })).toBe(true);
    expect(await port.get('a')).toBe('3');
    expect(await port.pTtl('a')).toBeGreaterThan(28_000);
    expect(await port.pTtl('missing')).toBe(-2);
    const window = () =>
      port.multi([
        { command: 'SET', key: 'f', value: '0', options: { EX: 60, NX: true } },
        { command: 'INCR', key: 'f' },
      ]);
    expect(await window()).toEqual(['OK', 1]);
    expect(await window()).toEqual([null, 2]);
    expect(await port.pTtl('f')).toBeGreaterThan(58_000);
    await port.multi([
      { command: 'LPUSH', key: 'check_in_list_1', value: '7' },
      { command: 'LPUSH', key: 'check_in_list_1', value: '8' },
      { command: 'LPUSH', key: 'check_in_list_2', value: '7' },
      { command: 'EXPIRE', key: 'check_in_list_1', seconds: 60 },
    ]);
    expect(await port.lRange('check_in_list_1', 0, -1)).toEqual(['8', '7']);
    expect((await port.scanKeys('check_in_list_*')).sort()).toEqual([
      'check_in_list_1',
      'check_in_list_2',
    ]);
    expect(await port.lRem('check_in_list_2', 0, '7')).toBe(1);
    expect(await port.exists('check_in_list_2')).toBe(false);
    expect(await port.mGet(['a', 'nope'])).toEqual(['3', null]);
    expect(await port.del(['a', 'f', 'nope'])).toBe(2);
  });
  it('consumes an OTP once and keeps the pending-login flag atomic', async () => {
    const otp = loginOtpState(redis.port, {
      SESSION_SECRET: 'redis-port-fixture-secret-'.repeat(2),
      LOGIN_OTP_EXPIRY: 180,
      LOGIN_OTP_MAX_ATTEMPTS: 3,
      LOGIN_OTP_RETRY_INTERVAL: 30,
      LOGIN_OTP_LOCK_SECONDS: 10800,
      LOGIN_OTP_RESEND_COOLDOWN: 30,
    });
    await otp.store('5', '123456');
    expect(await otp.check('5', '000000')).toBe(false);
    const results = await Promise.all(Array.from({ length: 5 }, () => otp.check('5', ' 123456 ')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await otp.claimAttempt('5')).toBe(true);
    expect(await otp.claimAttempt('5')).toBe(false);
    expect((await otp.recordFailure('5')).attemptsLeft).toBe(2);
    expect((await otp.recordFailure('5')).attemptsLeft).toBe(1);
    expect(await otp.recordFailure('5')).toEqual({ attemptsLeft: 0, failures: 3 });
    expect(await otp.isLocked('5')).toBe(true);
    const pending = pendingLogins(redis.port, 300),
      credential = await pending.begin('5');
    expect(await pending.userId(credential)).toBe('5');
    expect(await pending.userId({ ...credential, secret: 'x'.repeat(43) })).toBeNull();
    expect(await pending.markOtpSent(credential)).toBe(false);
    expect(await pending.markOtpSent(credential)).toBe(true);
    await pending.discard(credential);
    expect(await pending.userId(credential)).toBeNull();
  });
});
