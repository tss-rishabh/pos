import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import type { Databases } from '../src/db/pools.js';
import type { Principal } from '../src/domain/access.js';
import { draftService, DRAFT_TTL_SECONDS } from '../src/modules/drafts.js';
import {
  memoryStateStore,
  redisStateStore,
  type PosStateStore,
} from '../src/modules/checkout/state-store.js';
import { privateRedisFixture } from './helpers/private-redis.js';

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

const operator: Principal = {
  id: '7',
  name: 'Operator',
  email: '',
  role: 3,
  userType: 1,
  storeIds: ['1'],
};
const draft = (id: string) => ({
  id,
  storeId: '1',
  counterId: '2',
  customerId: null,
  lines: [{ productId: '11', name: 'Tee', barcode: null, unitPrice: '499.00', quantity: 1 }],
  version: 1,
});

describe('draft list', () => {
  it('reads every indexed draft with one MGET, in index order, skipping expired drafts', async () => {
    const memory = memoryStateStore(),
      calls: { get: string[]; getMany: string[][] } = { get: [], getMany: [] };
    const store: PosStateStore = {
      ...memory,
      async get(key) {
        calls.get.push(key);
        return memory.get(key);
      },
      async getMany(keys) {
        calls.getMany.push([...keys]);
        return memory.getMany(keys);
      },
    };
    const [first, expired, last] = [randomUUID(), randomUUID(), randomUUID()];
    await memory.set('pos:drafts:7:1', JSON.stringify([last, expired, first]), DRAFT_TTL_SECONDS);
    for (const id of [first, last])
      await memory.set(`pos:draft:7:1:${id}`, JSON.stringify(draft(id)), DRAFT_TTL_SECONDS);

    const drafts = await draftService({} as Databases, store).list(operator, '1');
    expect(drafts.map((row) => row.id)).toEqual([last, first]);
    expect(drafts[0]).toEqual(draft(last));
    expect(calls.get).toEqual(['pos:drafts:7:1']);
    expect(calls.getMany).toEqual([
      [`pos:draft:7:1:${last}`, `pos:draft:7:1:${expired}`, `pos:draft:7:1:${first}`],
    ]);
  });

  it.skipIf(!hasRedis)('lists drafts through MGET on a private loopback Redis', async () => {
    const fixture = await privateRedisFixture(),
      store = redisStateStore(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: 'drafts-list-fixture-secret-'.repeat(2),
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_e_drafts_unused',
          MYSQL_WRITER_URL: 'mysql://root@127.0.0.1/pos_e_drafts_unused',
        }),
        fixture.url,
      );
    try {
      const [first, missing, last] = [randomUUID(), randomUUID(), randomUUID()];
      await store.set('pos:drafts:7:1', JSON.stringify([first, missing, last]), 60);
      for (const id of [first, last])
        await store.set(`pos:draft:7:1:${id}`, JSON.stringify(draft(id)), 60);
      expect(await store.getMany([])).toEqual([]);
      const drafts = await draftService({} as Databases, store).list(operator, '1');
      expect(drafts.map((row) => row.id)).toEqual([first, last]);
    } finally {
      await store.close();
      await fixture.close();
    }
  });

  it('rejects an unreadable draft instead of treating it as absent', async () => {
    const store = memoryStateStore(),
      id = randomUUID();
    await store.set('pos:drafts:7:1', JSON.stringify([id]), DRAFT_TTL_SECONDS);
    await store.set(`pos:draft:7:1:${id}`, '{', DRAFT_TTL_SECONDS);
    await expect(draftService({} as Databases, store).list(operator, '1')).rejects.toMatchObject({
      code: 'CHECKOUT_STATE_UNREADABLE',
    });
  });
});
