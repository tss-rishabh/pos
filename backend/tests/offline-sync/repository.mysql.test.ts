import { randomUUID } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  offlineComment,
  offlineSyncRepository,
  type OfflineSyncRepository,
} from '../../src/modules/offline-sync/repository.js';
import { createProductionSchema } from '../helpers/production-schema.js';

/**
 * Candidate match before an offline order is created (audit workstream B) on legacy tables.
 * Run with OFFLINE_SYNC_MYSQL_TEST_URL=mysql://root@127.0.0.1:<port>/ (isolated loopback server).
 */
const template = process.env.OFFLINE_SYNC_MYSQL_TEST_URL;
const reference = 'OFF-12-3-ABCDEF01-1';
const billedAt = Date.UTC(2026, 10, 19, 9);

describe.skipIf(!template)('offline sync candidate match on legacy tables', () => {
  let connection: Connection, db: Databases, repository: OfflineSyncRepository, schema: string;
  const order = async (
    id: number,
    input: {
      store?: number;
      counter?: number;
      paid?: boolean;
      createdAt?: string;
      lines: [number, number][];
      comment?: string;
    },
  ) => {
    await connection.query(
      'INSERT INTO orders (id, user_id, payment_status, order_status, created_at, updated_at) VALUES (?, 1, ?, 1, ?, ?)',
      [
        id,
        input.paid ? 4 : 1,
        input.createdAt ?? '2026-11-19 15:00:00',
        input.createdAt ?? '2026-11-19 15:00:00',
      ],
    );
    await connection.query(
      'INSERT INTO order_stores (order_id, store_id, counter_id, order_invoice) VALUES (?, ?, ?, ?)',
      [id, input.store ?? 12, input.counter ?? 3, `INV${id}`],
    );
    for (const [product, qty] of input.lines)
      await connection.query('INSERT INTO has_products (order_id, prod_id, qty) VALUES (?, ?, ?)', [
        id,
        product,
        qty,
      ]);
    if (input.comment)
      await connection.query(
        'INSERT INTO comments (order_id, status_id, comment, user_id, created_at, updated_at) VALUES (?, 1, ?, 77, NOW(), NOW())',
        [id, input.comment],
      );
  };
  const match = (lines = [{ productId: '1001', quantity: 2 }]) =>
    repository.unconfirmedOrder({
      storeId: '12',
      counterId: '3',
      reference,
      lines,
      from: billedAt - 24 * 3600_000,
      to: billedAt + 2 * 3600_000,
    });

  beforeAll(async () => {
    const url = new URL(template!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Isolated loopback MySQL required.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    schema = await createProductionSchema(
      connection,
      'pos_b_offline_' + randomUUID().replaceAll('-', '').slice(0, 12),
      ['orders', 'order_stores', 'has_products', 'comments'],
    );
    url.pathname = '/' + schema;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'offline-sync-fixture-session-secret-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
      }),
    );
    repository = offlineSyncRepository(db, 'Asia/Kolkata');
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection.end();
    }
  });

  it('finds nothing when no order at the counter has the sale lines', async () => {
    await order(100, { paid: true, lines: [[1001, 2]] });
    await order(101, { counter: 4, lines: [[1001, 2]] });
    await order(102, { lines: [[1001, 3]] });
    await order(103, {
      lines: [[1001, 2]],
      comment: offlineComment('OFF-12-3-ABCDEF01-9', billedAt),
    });
    await order(104, { lines: [[1001, 2]], createdAt: '2026-11-17 10:00:00' });
    await expect(match()).resolves.toBeNull();
  });

  it('finds an unpaid, uncommented order with the sale lines', async () => {
    await order(110, {
      lines: [
        [1001, 1],
        [1001, 1],
        [2002, 1],
      ],
    });
    await expect(match()).resolves.toBe('110');
  });

  it('prefers the newest candidate and finds an order carrying this sale comment', async () => {
    await order(120, {
      paid: true,
      lines: [[1001, 2]],
      comment: offlineComment(reference, billedAt),
    });
    await expect(match()).resolves.toBe('120');
    await expect(match([{ productId: '3003', quantity: 1 }])).resolves.toBeNull();
  });
});
