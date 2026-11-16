import { createClient } from 'redis';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';

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
  close(): Promise<void>;
}
// The first key/value remains compatible with source POSAdmin.redis database0.
// Metadata binds it to current credentials; Lua comparison makes consumption atomic.
const issueScript = `
local current=redis.call('GET',KEYS[1])
if current and redis.call('GET',KEYS[2])==ARGV[1] then return {current,redis.call('PTTL',KEYS[1]),redis.call('PTTL',KEYS[2])} end
redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3])
redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[3])
return {ARGV[2],tonumber(ARGV[3])*1000,tonumber(ARGV[3])*1000}`;
const attemptScript = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;
const consumeScript = `
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] or redis.call('EXISTS',KEYS[3])==1 then return 0 end
redis.call('SET',KEYS[1],ARGV[3],'EX',ARGV[4])
redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[4])
redis.call('SET',KEYS[3],'1','EX',ARGV[5])
return 1`;
const revokeScript = `if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1],KEYS[2]) end; return 1`;
const keys = (id: string) => [`auth_qr_${id}`, `pos_rewrite:auth_qr:version:${id}`];

export function redisDeviceHandoffStore(config: Config, connectionUrl: string): DeviceHandoffStore {
  const url = new URL(connectionUrl),
    local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    !['', '/', '/0'].includes(url.pathname) ||
    (!local && url.protocol !== 'rediss:') ||
    (config.NODE_ENV === 'production' && url.protocol !== 'rediss:') ||
    (config.DEMO_MODE && !local)
  )
    throw new AppError(
      503,
      'DEVICE_HANDOFF_CONFIGURATION_INVALID',
      'Configure the verified POS authentication cache with TLS.',
    );
  let client: ReturnType<typeof createClient> | undefined,
    ready: Promise<ReturnType<typeof createClient>> | undefined;
  function reset(connection: ReturnType<typeof createClient>) {
    if (connection.isOpen) connection.destroy();
    if (client === connection) {
      client = undefined;
      ready = undefined;
    }
  }
  async function command<T>(
    run: (connection: ReturnType<typeof createClient>) => Promise<T>,
  ): Promise<T> {
    if (!client) {
      client = createClient({
        url: connectionUrl,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 20,
        socket: { connectTimeout: 1000, reconnectStrategy: false },
      });
      // Redis errors can contain connection credentials. Only fixed AppError codes escape.
      client.on('error', () => {});
      const connection = client;
      ready = connection.connect().then(() => connection);
    }
    const connection = client,
      signal = AbortSignal.timeout(2000),
      abort = () => reset(connection);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await ready;
      return await run(connection.withCommandOptions({ timeout: 1500, abortSignal: signal }));
    } catch {
      reset(connection);
      throw new AppError(
        503,
        'DEVICE_HANDOFF_CACHE_UNAVAILABLE',
        'Device sign-in is unavailable. Try again after reconnecting.',
      );
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    async issue(id, version, candidate, ttl) {
      const parsed = z
        .tuple([secret, z.coerce.number().int().min(0), z.coerce.number().int().min(0)])
        .safeParse(
          await command((c) =>
            c.eval(issueScript, {
              keys: keys(id),
              arguments: [fingerprint.parse(version), secret.parse(candidate), String(ttl)],
            }),
          ),
        );
      if (!parsed.success)
        throw new AppError(
          503,
          'DEVICE_HANDOFF_CACHE_INVALID',
          'The device sign-in state is unavailable.',
        );
      return { secret: parsed.data[0], ttlMs: Math.min(parsed.data[1], parsed.data[2]) };
    },
    async read(id) {
      const values = await command((c) => c.mGet(keys(id)));
      const parsed = z.tuple([secret.nullable(), fingerprint.nullable()]).safeParse(values);
      return parsed.success && parsed.data[0] && parsed.data[1]
        ? { secret: parsed.data[0], version: parsed.data[1] }
        : null;
    },
    async attempt(subject, windowSeconds) {
      const count = await command((c) =>
        c.eval(attemptScript, {
          keys: [`pos_rewrite:auth_qr:attempt:${subject}`],
          arguments: [String(windowSeconds)],
        }),
      );
      return z.coerce.number().int().positive().parse(count) <= 5;
    },
    async consume(id, version, expected, next, used, ttl, usedTtl) {
      const result = await command((c) =>
        c.eval(consumeScript, {
          keys: [...keys(id), `pos_rewrite:auth_qr:used:${used}`],
          arguments: [expected, version, next, String(ttl), String(usedTtl)],
        }),
      );
      return result === 1;
    },
    async revoke(id, expected) {
      await command((c) => c.eval(revokeScript, { keys: keys(id), arguments: [expected] }));
    },
    async close() {
      if (client) reset(client);
    },
  };
}
