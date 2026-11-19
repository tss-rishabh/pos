import { createClient } from 'redis';
import { privateRedisFixture } from '../../tests/helpers/private-redis.js';

/**
 * Checks that the Redis server the e2e stacks spawn (redis-server, or E2E_REDIS_SERVER such as
 * Memurai on Windows) supports every command family the backend relies on: SET NX EX/PX, Lua
 * (EVAL/EVALSHA), RPOPLPUSH/BRPOPLPUSH job queues, list ops, sorted sets, SCAN, TTLs, TIME, MGET and
 * pub/sub. It runs against its own private loopback instance with synthetic keys only.
 */
const redis = await privateRedisFixture();
const client = createClient({ url: redis.url });
const subscriber = client.duplicate();
const results: Record<string, boolean> = {};
const send = (args: string[]): Promise<unknown> => client.sendCommand(args);
const check = (name: string, ok: boolean) => {
  results[name] = ok;
};
try {
  await client.connect();
  await subscriber.connect();
  const info = await send(['INFO', 'server']);
  const version = /redis_version:([^\r\n]+)/.exec(String(info))?.[1] ?? 'unknown';
  check('SET NX EX', (await send(['SET', 'pos:compat:a', '1', 'NX', 'EX', '30'])) === 'OK');
  check('SET NX refuses', (await send(['SET', 'pos:compat:a', '2', 'NX', 'EX', '30'])) === null);
  check('SET XX PX', (await send(['SET', 'pos:compat:a', '3', 'XX', 'PX', '30000'])) === 'OK');
  const ttl = Number(await send(['PTTL', 'pos:compat:a']));
  check('PTTL', ttl > 0 && ttl <= 30000);
  check(
    'EXPIRE/TTL',
    Number(await send(['EXPIRE', 'pos:compat:a', '60'])) === 1 &&
      Number(await send(['TTL', 'pos:compat:a'])) > 0,
  );
  const lua = "return redis.call('INCRBY', KEYS[1], ARGV[1])";
  check('EVAL', Number(await send(['EVAL', lua, '1', 'pos:compat:n', '5'])) === 5);
  const sha = String(await send(['SCRIPT', 'LOAD', lua]));
  check('EVALSHA', Number(await send(['EVALSHA', sha, '1', 'pos:compat:n', '2'])) === 7);
  await send(['LPUSH', 'pos:compat:q', 'job-1', 'job-2']);
  // The job claimer uses RPOPLPUSH/BRPOPLPUSH (Redis 2.2+), not LMOVE/BLMOVE (6.2+): UAT runs 6.0.
  check('RPOPLPUSH', (await send(['RPOPLPUSH', 'pos:compat:q', 'pos:compat:w'])) === 'job-1');
  check(
    'BRPOPLPUSH',
    (await send(['BRPOPLPUSH', 'pos:compat:q', 'pos:compat:w', '1'])) === 'job-2',
  );
  check(
    'BRPOPLPUSH timeout',
    (await send(['BRPOPLPUSH', 'pos:compat:q', 'pos:compat:w', '0.2'])) === null,
  );
  check(
    'LRANGE',
    JSON.stringify(await send(['LRANGE', 'pos:compat:w', '0', '-1'])) === '["job-2","job-1"]',
  );
  check('LREM', Number(await send(['LREM', 'pos:compat:w', '1', 'job-1'])) === 1);
  await send(['ZADD', 'pos:compat:z', '10', 'a', '20', 'b']);
  check(
    'ZRANGEBYSCORE',
    JSON.stringify(await send(['ZRANGEBYSCORE', 'pos:compat:z', '0', '15'])) === '["a"]',
  );
  check('ZREM', Number(await send(['ZREM', 'pos:compat:z', 'a'])) === 1);
  const scan = (await send(['SCAN', '0', 'MATCH', 'pos:compat:*', 'COUNT', '100'])) as unknown[];
  check(
    'SCAN',
    Array.isArray(scan) && Array.isArray(scan[1]) && (scan[1] as unknown[]).length >= 3,
  );
  check(
    'EXISTS/MGET',
    Number(await send(['EXISTS', 'pos:compat:a'])) === 1 &&
      Array.isArray(await send(['MGET', 'pos:compat:a', 'pos:compat:none'])),
  );
  const time = (await send(['TIME'])) as unknown[];
  check('TIME', Array.isArray(time) && time.length === 2);
  const multi = await client.multi().set('pos:compat:m', '1').get('pos:compat:m').exec();
  check('MULTI/EXEC', JSON.stringify(multi) === '["OK","1"]');
  const received = new Promise<string>((resolve) => {
    void subscriber.subscribe('pos:compat:channel', (message) => resolve(message));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await client.publish('pos:compat:channel', 'hello');
  check(
    'PUBLISH/SUBSCRIBE',
    (await Promise.race([
      received,
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 3000)),
    ])) === 'hello',
  );
  check(
    'DEL/UNLINK',
    Number(await send(['DEL', 'pos:compat:a', 'pos:compat:n'])) === 2 &&
      Number(await send(['UNLINK', 'pos:compat:w'])) === 1,
  );
  const failed = Object.entries(results)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  process.stdout.write(
    JSON.stringify({
      server: process.env.E2E_REDIS_SERVER ? 'E2E_REDIS_SERVER' : 'redis-server',
      version,
      results,
      passed: failed.length === 0,
    }) + '\n',
  );
  if (failed.length) process.exitCode = 1;
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      passed: false,
      results,
      error: error instanceof Error ? error.message.slice(0, 200) : 'failed',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await subscriber.quit().catch(() => undefined);
  await client.quit().catch(() => undefined);
  await redis.close();
}
