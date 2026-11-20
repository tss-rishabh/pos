import { connectRedisPort } from '../../src/redis/node-client.js';
import { memoryRedisPort } from './memory-redis.js';
import type { RedisPort } from '../../src/redis/port.js';
import { privateRedisFixture, redisServerAvailable } from './private-redis.js';

/** True when a loopback Redis-compatible server can be spawned for this run. */
export { redisServerAvailable };
export interface AuthRedisBackend {
  name: 'redis-server' | 'in-process';
  open(): Promise<{ port: RedisPort; flush(): Promise<void>; close(): Promise<void> }>;
}
/**
 * Redis-backed auth tests run against a private loopback `redis-server` when one is
 * installed, and always against the in-process port that implements the same commands.
 */
export const authRedisBackends: AuthRedisBackend[] = [
  ...(redisServerAvailable
    ? [
        {
          name: 'redis-server' as const,
          async open() {
            const server = await privateRedisFixture(),
              port = connectRedisPort(server.url, 'test');
            return {
              port,
              async flush() {
                const keys = await port.scanKeys('*');
                if (keys.length) await port.del(keys);
              },
              async close() {
                await port.close();
                await server.close();
              },
            };
          },
        },
      ]
    : []),
  {
    name: 'in-process' as const,
    async open() {
      const port = memoryRedisPort();
      return {
        port,
        async flush() {
          const keys = await port.scanKeys('*');
          if (keys.length) await port.del(keys);
        },
        async close() {},
      };
    },
  },
];
