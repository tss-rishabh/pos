import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { createDatabases } from '../src/db/pools.js';
import { draftService, type DraftMutation } from '../src/modules/drafts.js';
import { memoryStateStore } from '../src/modules/checkout/state-store.js';
import type { Principal } from '../src/domain/access.js';

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('draft persistence (Redis state, MySQL counter check)', () => {
  const user: Principal = {
    userType: 1,
    id: String(Math.floor(Math.random() * 1_000_000) + 9_000_000),
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 5,
    storeIds: ['999991'],
  };
  const isolated = connection || 'mysql://root@127.0.0.1/pos_rewrite_integration';
  const db = createDatabases(
    readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: isolated,
      MYSQL_WRITER_URL: isolated,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      SESSION_SECRET: 'integration-fixture-'.repeat(3),
    }),
  );
  const service = draftService(db, memoryStateStore());
  let setupComplete = false;
  beforeAll(async () => {
    const url = new URL(connection!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      !url.pathname.endsWith('/pos_rewrite_integration')
    )
      throw new Error(
        'Integration tests only use the isolated local pos_rewrite_integration schema.',
      );
    const admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    try {
      await admin.query('CREATE DATABASE IF NOT EXISTS pos_rewrite_integration');
      await admin.changeUser({ database: 'pos_rewrite_integration' });
      await admin.query(
        'CREATE TABLE IF NOT EXISTS store_counters (id BIGINT PRIMARY KEY,store_id BIGINT NOT NULL,is_active BOOLEAN NOT NULL)',
      );
      await admin.query(
        'INSERT IGNORE INTO store_counters(id,store_id,is_active) VALUES (999991,999991,1)',
      );
      setupComplete = true;
    } finally {
      await admin.end();
    }
  });
  afterAll(async () => {
    if (!setupComplete) {
      await db.close();
      return;
    }
    await db.close();
  });
  const input = (): DraftMutation => ({
    mutationId: crypto.randomUUID(),
    expectedVersion: 0,
    draft: {
      id: crypto.randomUUID(),
      storeId: '999991',
      counterId: '999991',
      customerId: null,
      lines: [
        { productId: '1001', name: 'Fixture item', barcode: null, unitPrice: '99.00', quantity: 1 },
      ],
    },
  });
  it('deduplicates ten simultaneous retries and recovers a lost response', async () => {
    const payload = input();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.save(user, payload)),
    );
    expect(results.every((r) => r.version === 1)).toBe(true);
    expect(await service.save(user, payload)).toEqual(results[0]);
    const rows = await service.list(user, '999991');
    expect(rows.filter((r) => r.id === payload.draft.id)).toHaveLength(1);
  });
  it('serializes competing versions and preserves exactly one winner', async () => {
    const one = input(),
      two = { ...structuredClone(one), mutationId: crypto.randomUUID() };
    two.draft.lines[0]!.quantity = 2;
    const results = await Promise.allSettled([service.save(user, one), service.save(user, two)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.code).toBe('DRAFT_CONFLICT');
  });
});
