import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { customerHistoryService } from '../../src/modules/customer-history/service.js';
import { customerHistoryGateway } from '../../src/modules/customer-history/gateway.js';
import type { HistoryCapture } from '../../src/modules/customer-history/contracts.js';

const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
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
describe('customer-history scope, pagination and reader boundaries', () => {
  it('captures the active checkout around the MySQL read, preserving duplicate item names and 64bit IDs', async () => {
    const capture = vi.fn(async () => captured),
      read = vi.fn(async () => result()),
      service = customerHistoryService(config, db, {
        capture,
        gateway: { read, lines: vi.fn() },
        clock: () => new Date('2026-11-16T10:00:00Z'),
      });
    const response = await service.read(user, scope, { limit: 2 });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith('7', '', 2);
    expect(response.recentOrders[0]!.id).toBe('9007199254740993');
    expect(response.returnedOrders.items[0]!.itemNames).toEqual(['Fixture child', 'Fixture child']);
    expect(response.returnedOrders.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(response.reader).toBe('primary');
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
  it('uses a signed descending anchor and rejects tampering, another checkout binding and another cursor purpose before MySQL', async () => {
    const read = vi.fn(async (_customer: string, before: string) =>
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
    expect(read.mock.calls[1]![1]).toBe('19');
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
  it('rejects contradictory ordering and unsafe source identities instead of silently changing source rows', async () => {
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
  it('reads customer history from the primary MySQL reader in a read-only snapshot, never BigQuery', async () => {
    const readers: string[] = [],
      configs: unknown[] = [],
      sentinel = new Error('Fixture reader.'),
      reader = {
        transaction: async (_work: unknown, value: unknown) => {
          configs.push(value);
          throw sentinel;
        },
      },
      primary = {
        get: (name: string) => {
          readers.push(name);
          return reader;
        },
        close: async () => {},
      } as unknown as Databases,
      gateway = customerHistoryGateway(primary);
    await expect(gateway.read('7', '', 25)).rejects.toBe(sentinel);
    await expect(gateway.lines('7', '9007199254740993', '', 50)).rejects.toBe(sentinel);
    expect(readers).toEqual(['primary', 'primary']);
    for (const value of configs)
      expect(value).toEqual({
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
  });
});
