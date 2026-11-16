import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { customerHistoryService } from '../../src/modules/customer-history/service.js';
import {
  customerHistoryGateway,
  type HistoryStatement,
} from '../../src/modules/customer-history/gateway.js';
import { observedHistoryTables } from '../../src/modules/customer-history/sql.js';
import type { HistoryCapture } from '../../src/modules/customer-history/contracts.js';

const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'customer-history-unit-'.repeat(4),
  }),
  user: Principal = {
    id: '44',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 5,
    userType: 1,
    storeIds: ['1'],
  },
  scope = { storeId: '1', checkoutId: '00000000-0000-4000-a000-000000000001' },
  db: Databases = {
    get: () => {
      throw new Error('Unexpected DB access.');
    },
    close: async () => {},
  },
  captured: HistoryCapture = {
    customerId: '7',
    checkoutVersion: 4,
    sourceNow: '2026-11-16 10:00:00',
    binding: 'a'.repeat(64),
  },
  summary = {
    exclusiveSavings: 70,
    totalOrders: '7',
    totalStoreOrders: '3',
    totalOnlineOrders: '4',
    last30DaysOrders: '4',
    cancelledOrders: '1',
    returnedOrders: '1',
    npsScore: 19 / 6,
  },
  row = (id: string) => ({
    id,
    orderAmount: 100,
    itemNames: ['Fixture child', 'Fixture child'],
    itemCount: '2',
    hasMoreItems: false,
    isStoreOrder: true,
  }),
  result = (ids = ['20', '19', '18']) => ({
    summary,
    recentOrders: [
      {
        id: '9007199254740993',
        orderAmount: 100,
        createdDate: '2026-11-16',
        status: 0,
        isStoreOrder: false,
      },
    ],
    returnedRows: ids.map(row),
  });
describe('customer-history scope, pagination and cost boundaries', () => {
  it('captures source NOW and active checkout around BQ, preserving duplicate item names and 64bit IDs', async () => {
    const capture = vi.fn(async () => captured),
      read = vi.fn(async () => result()),
      service = customerHistoryService(config, db, {
        capture,
        gateway: { read, lines: vi.fn() },
        clock: () => new Date('2026-11-16T10:00:00Z'),
      });
    const response = await service.read(user, scope, { limit: 2 });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith('7', captured.sourceNow, '', 2);
    expect(response.recentOrders[0]!.id).toBe('9007199254740993');
    expect(response.returnedOrders.items[0]!.itemNames).toEqual(['Fixture child', 'Fixture child']);
    expect(response.returnedOrders.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(response.reader).toBe('bigquery');
  });
  it('aborts stale/revoked contexts after HTTP without returning a fetched customer history', async () => {
    let calls = 0;
    const read = vi.fn(async () => result()),
      service = customerHistoryService(config, db, {
        capture: async () =>
          ++calls === 1 ? captured : { ...captured, customerId: '8', binding: 'b'.repeat(64) },
        gateway: { read, lines: vi.fn() },
      });
    await expect(service.read(user, scope, {})).rejects.toMatchObject({
      code: 'CUSTOMER_HISTORY_CONTEXT_CHANGED',
    });
    calls = 0;
    const revoked = customerHistoryService(config, db, {
      capture: async () => {
        if (++calls === 2) throw new AppError(403, 'STORE_ACCESS_DENIED', 'Fixture revoked.');
        return captured;
      },
      gateway: { read, lines: vi.fn() },
    });
    await expect(revoked.read(user, scope, {})).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });
  it('uses a signed descending anchor and rejects tampering, another checkout binding and another cursor purpose before BQ', async () => {
    const read = vi.fn(async (_customer: string, _now: string, before: string) =>
        before ? result(['17', '16']) : result(),
      ),
      lines = vi.fn(),
      service = customerHistoryService(config, db, {
        capture: async () => captured,
        gateway: { read, lines },
      }),
      first = await service.read(user, scope, { limit: 2 }),
      token = first.returnedOrders.nextCursor!;
    const second = await service.read(user, scope, { returnBefore: token, limit: 2 });
    expect(read.mock.calls[1]![2]).toBe('19');
    expect(second.returnedOrders.items.map((value) => value.id)).toEqual(['17', '16']);
    expect(second.returnedOrders.nextCursor).toBeNull();
    const prior = read.mock.calls.length;
    await expect(
      service.read(user, scope, {
        returnBefore: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CUSTOMER_HISTORY_CURSOR' });
    expect(read).toHaveBeenCalledTimes(prior);
    const other = customerHistoryService(config, db, {
      capture: async () => ({ ...captured, binding: 'b'.repeat(64) }),
      gateway: { read, lines },
    });
    await expect(other.read(user, scope, { returnBefore: token })).rejects.toMatchObject({
      code: 'INVALID_CUSTOMER_HISTORY_CURSOR',
    });
    await expect(service.lines(user, scope, '20', { before: token })).rejects.toMatchObject({
      code: 'INVALID_CUSTOMER_HISTORY_CURSOR',
    });
    expect(lines).not.toHaveBeenCalled();
  });
  it('rejects contradictory ordering and unsafe warehouse identities instead of silently changing source rows', async () => {
    const service = customerHistoryService(config, db, {
      capture: async () => captured,
      gateway: { read: async () => result(['18', '19']), lines: vi.fn() },
    });
    await expect(service.read(user, scope, {})).rejects.toMatchObject({
      code: 'CUSTOMER_HISTORY_DATA_INVALID',
    });
    const invalid = customerHistoryService(config, db, {
      capture: async () => captured,
      gateway: {
        read: async () => ({
          ...result(),
          recentOrders: [{ ...result().recentOrders[0], id: 9007199254740992 }],
        }),
        lines: vi.fn(),
      },
    });
    await expect(invalid.read(user, scope, {})).rejects.toMatchObject({
      code: 'CUSTOMER_HISTORY_DATA_INVALID',
    });
  });
  it('paginates duplicate-SKU HPs with an order-bound signature and denies foreign/absent orders', async () => {
    const lines = vi.fn(async () => ({
        orderFound: true,
        items: ['30', '29', '28'].map((id) => ({ id, productId: '11', name: 'Fixture child' })),
      })),
      service = customerHistoryService(config, db, {
        capture: async () => captured,
        gateway: { read: vi.fn(), lines },
      }),
      first = await service.lines(user, scope, '20', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]!.productId).toBe(first.items[1]!.productId);
    await expect(
      service.lines(user, scope, '21', { before: first.nextCursor! }),
    ).rejects.toMatchObject({ code: 'INVALID_CUSTOMER_HISTORY_CURSOR' });
    const absent = customerHistoryService(config, db, {
      capture: async () => captured,
      gateway: { read: vi.fn(), lines: async () => ({ orderFound: false, items: [] }) },
    });
    await expect(absent.lines(user, scope, '99', {})).rejects.toMatchObject({
      code: 'CUSTOMER_HISTORY_ORDER_NOT_FOUND',
    });
  });
  it('validates input before capture or transport and never accepts a caller-supplied customer override', async () => {
    const capture = vi.fn(async () => captured),
      read = vi.fn(),
      service = customerHistoryService(config, db, { capture, gateway: { read, lines: vi.fn() } });
    for (const input of [
      { limit: 101 },
      { limit: 0 },
      { customerId: '99' },
      { returnBefore: '20' },
    ])
      await expect(service.read(user, scope, input)).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('dry-runs within the configured budget before execution and never raises the cap or falls back to MySQL', async () => {
    const query = vi.fn(async () => [result()]),
      estimate = vi.fn(async () => BigInt(config.BIGQUERY_MAX_BYTES_BILLED) + 1n),
      gateway = customerHistoryGateway(config, undefined, estimate, query);
    await expect(gateway.read('7', captured.sourceNow, '', 25)).rejects.toMatchObject({
      code: 'CUSTOMER_HISTORY_PROJECTION_REQUIRED',
    });
    expect(query).not.toHaveBeenCalled();
    const under = customerHistoryGateway(config, undefined, async () => 1n, query);
    await under.read('7', captured.sourceNow, '', 25);
    expect(query).toHaveBeenCalledTimes(1);
    const call = query.mock.calls[0];
    expect(call).toBeDefined();
  });
  it('requires configured partitioned fact tables and binds the customer bucket on every historical fact scan', async () => {
    const estimate = vi.fn(async (_value: HistoryStatement) => 1n),
      query = vi.fn(async () => [result()]);
    expect(() =>
      customerHistoryGateway(config, observedHistoryTables, estimate, query, 'customer-bucket-v1'),
    ).toThrowError(AppError);
    const tables = {
        ...observedHistoryTables,
        orders: 'tssgcp2025.fixture_history.orders_v1',
        orderStores: 'tssgcp2025.fixture_history.order_stores_v1',
        lines: 'tssgcp2025.fixture_history.lines_v1',
        feedback: 'tssgcp2025.fixture_history.feedback_v1',
      },
      gateway = customerHistoryGateway(config, tables, estimate, query, 'customer-bucket-v1');
    await gateway.read('7', captured.sourceNow, '', 25);
    await gateway.lines('7', '9007199254740993', '', 50);
    const history = estimate.mock.calls[0]![0],
      lines = estimate.mock.calls[1]![0];
    for (const alias of ['o', 'os', 'hp', 'nf'])
      expect(history.statement).toContain(
        alias + '.customer_bucket=MOD(CAST(@customer AS INT64),1024)',
      );
    expect(lines.statement).toContain('o.customer_bucket=MOD(CAST(@customer AS INT64),1024)');
    expect(lines.statement).toContain('hp.customer_bucket=MOD(CAST(@customer AS INT64),1024)');
    expect(history.params).toEqual({
      customer: '7',
      sourceNow: captured.sourceNow,
      returnBefore: '',
      pageSize: 26,
    });
    expect(lines.params).toEqual({
      customer: '7',
      order: '9007199254740993',
      before: '',
      pageSize: 51,
    });
  });
});
