import { spawnSync } from 'node:child_process';
import { connectRedisPort } from '../../src/redis/node-client.js';
import { memoryRedisPort } from '../../src/redis/memory.js';
import type { RedisPort } from '../../src/redis/port.js';
import { privateRedisFixture } from './private-redis.js';

/** True when a loopback `redis-server` can be spawned for this run. */
export const redisServerAvailable =
  spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
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
