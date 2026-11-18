import { z } from 'zod';
import { defineScript, type RedisPort } from '../redis/port.js';
import { authKeys } from './keys.js';

const secret = z.string().regex(/^[A-Z2-7]{32}$/),
  fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export interface DeviceHandoffStore {
  issue(
    operatorId: string,
    version: string,
    candidate: string,
    ttl: number,
  ): Promise<{ secret: string; ttlMs: number }>;
  read(operatorId: string): Promise<{ secret: string; version: string } | null>;
  attempt(subject: string, windowSeconds: number): Promise<boolean>;
  consume(
    operatorId: string,
    version: string,
    expected: string,
    next: string,
    used: string,
    ttl: number,
    usedTtl: number,
  ): Promise<boolean>;
  revoke(operatorId: string, expected: string): Promise<void>;
}
const keys = (id: string) => [authKeys.deviceSecret(id), authKeys.deviceVersion(id)];
/**
 * `auth_qr_{uid}` stays the legacy key and value (POSAdmin redis database 0). S9 hardening
 * binds it to the operator's password hash (`pos:auth_qr:version:`), limits attempts and
 * makes a verified code single use. Scripts keep each step atomic.
 */
const issueScript = defineScript<[string, number, number]>({
  name: 'device-handoff-issue',
  lua: `local current=redis.call('GET',KEYS[1])
if current and redis.call('GET',KEYS[2])==ARGV[1] then return {current,redis.call('PTTL',KEYS[1]),redis.call('PTTL',KEYS[2])} end
redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3])
redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[3])
return {ARGV[2],tonumber(ARGV[3])*1000,tonumber(ARGV[3])*1000}`,
  emulate(store, [secretKey, versionKey], [version, candidate, ttl]) {
    const current = store.get(secretKey!);
    if (current !== null && store.get(versionKey!) === version)
      return [current, store.pTtl(secretKey!), store.pTtl(versionKey!)];
    store.set(secretKey!, candidate!, Number(ttl) * 1000);
    store.set(versionKey!, version!, Number(ttl) * 1000);
    return [candidate, Number(ttl) * 1000, Number(ttl) * 1000];
  },
  parse: (reply) =>
    z.tuple([secret, z.coerce.number().int().min(0), z.coerce.number().int().min(0)]).parse(reply),
});
const attemptScript = defineScript<number>({
  name: 'device-handoff-attempt',
  lua: `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`,
  emulate(store, [key], [window]) {
    const next = Number(store.get(key!) ?? '0') + 1;
    store.set(key!, String(next), next === 1 ? Number(window) * 1000 : 'keep');
    return next;
  },
  parse: (reply) => z.coerce.number().int().positive().parse(reply),
});
const consumeScript = defineScript<boolean>({
  name: 'device-handoff-consume',
  lua: `if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] or redis.call('EXISTS',KEYS[3])==1 then return 0 end
redis.call('SET',KEYS[1],ARGV[3],'EX',ARGV[4])
redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[4])
redis.call('SET',KEYS[3],'1','EX',ARGV[5])
return 1`,
  emulate(store, [secretKey, versionKey, usedKey], [expected, version, next, ttl, usedTtl]) {
    if (
      store.get(secretKey!) !== expected ||
      store.get(versionKey!) !== version ||
      store.exists(usedKey!)
    )
      return 0;
    store.set(secretKey!, next!, Number(ttl) * 1000);
    store.set(versionKey!, version!, Number(ttl) * 1000);
    store.set(usedKey!, '1', Number(usedTtl) * 1000);
    return 1;
  },
  parse: (reply) => z.union([z.literal(0), z.literal(1)]).parse(reply) === 1,
});
const revokeScript = defineScript<number>({
  name: 'device-handoff-revoke',
  lua: `if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1],KEYS[2]) end; return 1`,
  emulate(store, [secretKey, versionKey], [expected]) {
    if (store.get(secretKey!) === expected) {
      store.del(secretKey!);
      store.del(versionKey!);
    }
    return 1;
  },
  parse: (reply) => z.literal(1).parse(reply),
});
export function redisDeviceHandoffStore(redis: RedisPort): DeviceHandoffStore {
  return {
    async issue(id, version, candidate, ttl) {
      const [current, secretTtl, versionTtl] = await redis.run(issueScript, keys(id), [
        fingerprint.parse(version),
        secret.parse(candidate),
        String(ttl),
      ]);
      return { secret: current, ttlMs: Math.min(secretTtl, versionTtl) };
    },
    async read(id) {
      const parsed = z
        .tuple([secret.nullable(), fingerprint.nullable()])
        .safeParse(await redis.mGet(keys(id)));
      return parsed.success && parsed.data[0] && parsed.data[1]
        ? { secret: parsed.data[0], version: parsed.data[1] }
        : null;
    },
    async attempt(subject, windowSeconds) {
      return (
        (await redis.run(
          attemptScript,
          [authKeys.deviceAttempt(subject)],
          [String(windowSeconds)],
        )) <= 5
      );
    },
    async consume(id, version, expected, next, used, ttl, usedTtl) {
      return redis.run(
        consumeScript,
        [...keys(id), authKeys.deviceUsed(used)],
        [expected, version, next, String(ttl), String(usedTtl)],
      );
    },
    async revoke(id, expected) {
      await redis.run(revokeScript, keys(id), [expected]);
    },
  };
}
