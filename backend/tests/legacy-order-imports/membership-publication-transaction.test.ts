import type { PoolConnection } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { readMembershipSourceSnapshot } from '../../src/modules/legacy-order-imports/membership-profile/publication-transaction.js';
import { membershipPublicationError } from '../../src/modules/legacy-order-imports/membership-profile/publication.js';

function setup(failure?: string) {
  const queries: string[] = [],
    release = vi.fn(),
    destroy = vi.fn();
  const query = vi.fn(async (input: { sql: string } | string): Promise<unknown> => {
    const statement = typeof input === 'string' ? input : input.sql;
    queries.push(statement);
    if (statement === failure) throw new Error('RAW_SOURCE_CANARY@example.test password SQL');
    return [[], []];
  });
  const connection = { query, release, destroy } as unknown as PoolConnection;
  const pool = { getConnection: vi.fn(async () => connection) };
  return { pool, connection, queries, query, release, destroy };
}
describe('dedicated native source snapshot transaction', () => {
  it('uses exact valid transaction syntax and releases the one source connection', async () => {
    const f = setup();
    expect(await readMembershipSourceSnapshot(f.pool, async () => 42)).toBe(42);
    expect(f.queries).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'COMMIT',
    ]);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.destroy).not.toHaveBeenCalled();
  });
  it.each([
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
  ])(
    'destroys a failed %s setup rather than leaking or returning pending transaction settings',
    async (statement) => {
      const f = setup(statement),
        read = vi.fn(async () => 42);
      await expect(readMembershipSourceSnapshot(f.pool, read)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_UNAVAILABLE',
      });
      expect(read).not.toHaveBeenCalled();
      expect(f.destroy).toHaveBeenCalledTimes(1);
      expect(f.release).not.toHaveBeenCalled();
    },
  );
  it('rolls back a rejected source read, preserves its safe error and releases the session', async () => {
    const f = setup();
    await expect(
      readMembershipSourceSnapshot(f.pool, async () => {
        throw membershipPublicationError('SOURCE_AMBIGUOUS');
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_AMBIGUOUS' });
    expect(f.queries.at(-1)).toBe('ROLLBACK');
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.destroy).not.toHaveBeenCalled();
  });
  it('destroys an uncertain rollback and never returns a signed capture', async () => {
    const f = setup('ROLLBACK');
    await expect(
      readMembershipSourceSnapshot(f.pool, async () => {
        throw new Error('RAW_SOURCE_CANARY@example.test');
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_UNAVAILABLE' });
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).not.toHaveBeenCalled();
  });
  it('does not acquire or start SQL after an abort, including an abort while waiting for a session', async () => {
    const f = setup(),
      abort = new AbortController();
    abort.abort();
    await expect(
      readMembershipSourceSnapshot(f.pool, async () => 42, { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_UNAVAILABLE' });
    expect(f.pool.getConnection).not.toHaveBeenCalled();
    const late = setup(),
      waiting = new AbortController();
    late.pool.getConnection.mockImplementation(async () => {
      waiting.abort();
      return late.connection;
    });
    await expect(
      readMembershipSourceSnapshot(late.pool, async () => 42, { signal: waiting.signal }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_UNAVAILABLE' });
    expect(late.queries).toEqual([]);
    expect(late.release).toHaveBeenCalledTimes(1);
  });
  it('suppresses acquisition errors without exposing driver/credential details', async () => {
    const f = setup();
    f.pool.getConnection.mockRejectedValue(
      new Error('RAW_SOURCE_CANARY@example.test password SQL'),
    );
    try {
      await readMembershipSourceSnapshot(f.pool, async () => 42);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_UNAVAILABLE',
      });
      expect(String(error)).not.toMatch(/CANARY|password|SQL/);
    }
  });
  it('interrupts a pending read on deadline by destroying only its dedicated read-only session', async () => {
    const f = setup(),
      abort = new AbortController();
    let rejectRead: ((error: Error) => void) | undefined;
    let started: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input) => {
      const statement = typeof input === 'string' ? input : input.sql;
      if (statement === 'SELECT 1')
        return new Promise((_, reject) => {
          rejectRead = reject;
          started();
        });
      return original(input);
    });
    f.destroy.mockImplementation(() => rejectRead?.(new Error('RAW_SOURCE_CANARY')));
    const task = expect(
      readMembershipSourceSnapshot(f.pool, async (snapshot) => snapshot.execute(sql`SELECT 1`), {
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_UNAVAILABLE' });
    await readStarted;
    expect(rejectRead).toBeDefined();
    abort.abort();
    await task;
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).not.toHaveBeenCalled();
  });
});
