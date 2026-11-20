import { randomUUID } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { returnWindowExtensions } from '../../src/modules/checkout/return-workflow/extensions.js';
import { goldenStdout } from '../golden/load.js';
import { createProductionSchema } from '../helpers/production-schema.js';

interface SourceResult {
  pin: string;
  line: number;
  created: Record<string, unknown>;
  updated: Record<string, unknown>;
  rows: number;
  emptyDateRefused: boolean;
}
const source = () => JSON.parse(goldenStdout('return-window', 'source')) as SourceResult;

describe('pinned return-window date and update semantics', () => {
  it('preserves exact tuple, end-of-day, native audit actor, shortening/reactivation and empty-date refusal', () => {
    const result = source();
    expect(result).toMatchObject({
      pin: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
      line: 4449,
      rows: 1,
      emptyDateRefused: true,
    });
    expect(result.created).toEqual({
      order_id: 100,
      prod_id: 123,
      has_product_id: 1000,
      extended_date: '2026-12-20 23:59:59',
      created_by: 88,
      updated_by: 88,
      is_active: 1,
    });
    expect(result.updated).toEqual({
      ...result.created,
      extended_date: '2026-11-18 23:59:59',
    });
  });
});

/**
 * The rewrite's extension writer (return-workflow/extensions.ts) replaying the same pinned
 * AjaxExtendReturnView sequence (order/views.py:4449: create for 12/20/2026, then shorten to
 * 11/18/2026, the capture day, then an empty date) on an isolated loopback MySQL, compared
 * column by column with the source rows above. Run with
 * CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1:<port>/<any>.
 * The line eligibility, role and MUser lookups are extensionScope's (covered by
 * tests/checkout/returns/returns.mysql.test.ts); here it returns the source actor, MUser 88.
 */
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('rewrite return-window extension against the pinned source rows', () => {
  let connection: Connection, db: Databases, schema: string;
  const manager: Principal = {
    id: '44',
    name: 'Fixture manager',
    email: 'manager@example.test',
    role: 2,
    userType: 1,
    storeIds: ['1'],
  };
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
      'pos_v2_return_window_' + randomUUID().replaceAll('-', '').slice(0, 12),
      ['extend_applicability_for_return_exchange'],
    );
    url.pathname = '/' + schema;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'return-window-source-session-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection.end();
    }
  });
  it('creates, shortens and refuses an empty date as the source does', async () => {
    // The source capture ran on 18 November 2026; shortening to that day is allowed then.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T06:30:00Z'));
    const expected = source();
    const extensions = returnWindowExtensions(
      db,
      { BUSINESS_TIMEZONE: 'Asia/Kolkata' },
      {
        repository: {
          extensionScope: async () => ({
            nativeActorId: BigInt(String(expected.created.created_by)),
            deliveredAt: '2026-11-01 10:00:00',
            periodDays: 15,
          }),
        },
      },
    );
    const orderId = String(expected.created.order_id),
      lineId = String(expected.created.has_product_id),
      scope = { counterId: '3', productId: String(expected.created.prod_id) };
    const read = () => extensions.read(manager, '1', orderId, lineId, scope);
    const row = async () => {
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT order_id, prod_id, has_product_id, extended_date, created_by, updated_by, is_active FROM extend_applicability_for_return_exchange',
      );
      return rows.map((value) =>
        Object.fromEntries(
          Object.entries(value).map(([key, column]) => [
            key,
            key === 'extended_date' ? column : Number(column),
          ]),
        ),
      );
    };
    await extensions.set(manager, '1', orderId, lineId, {
      ...scope,
      date: '2026-12-20',
      expectedRevision: (await read()).revision,
    });
    expect(await row()).toEqual([expected.created]);
    await extensions.set(manager, '1', orderId, lineId, {
      ...scope,
      date: '2026-11-18',
      expectedRevision: (await read()).revision,
    });
    expect(await row()).toEqual([expected.updated]);
    expect(expected.emptyDateRefused).toBe(true);
    await expect(
      extensions.set(manager, '1', orderId, lineId, {
        ...scope,
        date: '',
        expectedRevision: (await read()).revision,
      }),
    ).rejects.toThrow();
    expect(await row()).toHaveLength(expected.rows);
    expect(await row()).toEqual([expected.updated]);
  });
});
