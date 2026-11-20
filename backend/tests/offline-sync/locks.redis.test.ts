import { execFileSync } from 'node:child_process';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  DEVICE_SALES_TTL_SECONDS,
  redisOfflineSyncCoordinator,
  saleKeys,
  type OfflineSyncCoordinator,
} from '../../src/modules/offline-sync/locks.js';
import { privateRedisFixture } from '../helpers/private-redis.js';

const hasRedis = (() => {
  try {
    execFileSync(process.env.E2E_REDIS_SERVER || 'redis-server', ['--version'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();
const device = 'abcdef0123456789abcdef0123456789';

describe.skipIf(!hasRedis)('offline sync device sales in Redis (private loopback)', () => {
  let fixture: Awaited<ReturnType<typeof privateRedisFixture>>,
    coordinator: OfflineSyncCoordinator,
    client: ReturnType<typeof createClient>;
  beforeAll(async () => {
    fixture = await privateRedisFixture();
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'offline-sync-redis-session-secret-'.repeat(2),
      // Unused here; the configuration requires them.
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: 'mysql://root@127.0.0.1:1/unused',
      MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1:1/unused',
    });
    coordinator = redisOfflineSyncCoordinator(config, fixture.url);
    client = createClient({ url: fixture.url });
    await client.connect();
  });
  afterAll(async () => {
    await coordinator?.close();
    if (client?.isOpen) client.destroy();
    await fixture?.close();
  });

  it('stores, updates and prunes device sales under one expiring hash', async () => {
    await expect(coordinator.deviceSales(device)).resolves.toEqual(new Map());
    await coordinator.saveDeviceSale(
      device,
      'OFF-12-3-ABCDEF01-1',
      { billedAt: 1000, sequence: 1, syncedAt: null },
      [],
    );
    await coordinator.saveDeviceSale(
      device,
      'OFF-12-3-ABCDEF01-2',
      { billedAt: 2000, sequence: 2, syncedAt: null },
      [],
    );
    await coordinator.saveDeviceSale(
      device,
      'OFF-12-3-ABCDEF01-2',
      { billedAt: 2000, sequence: 2, syncedAt: 3000 },
      ['OFF-12-3-ABCDEF01-1'],
    );
    await client.hSet(saleKeys.device(device), 'OFF-12-3-ABCDEF01-3', 'not json');
    expect(await coordinator.deviceSales(device)).toEqual(
      new Map([['OFF-12-3-ABCDEF01-2', { billedAt: 2000, sequence: 2, syncedAt: 3000 }]]),
    );
    const ttl = await client.ttl(saleKeys.device(device));
    expect(ttl).toBeGreaterThan(DEVICE_SALES_TTL_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(DEVICE_SALES_TTL_SECONDS);
  });
});
