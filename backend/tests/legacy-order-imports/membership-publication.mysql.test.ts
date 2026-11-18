import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Databases } from '../../src/db/pools.js';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import * as snapshots from '../../src/modules/legacy-order-imports/membership-profile/publication-transaction.js';
import {
  csvMembershipNativeSnapshot,
  csvMembershipNativeSnapshotContract,
} from '../../src/modules/legacy-order-imports/membership-profile/publication-native.js';
import {
  sealCsvMembershipHistoryPublication,
  verifyCsvMembershipSourceCapture,
} from '../../src/modules/legacy-order-imports/membership-profile/publication.js';
import { membershipPublicationFixture } from '../../tools/legacy-order-imports/membership-publication-fixture.js';
import {
  membershipBigQueryFixture,
  membershipFixtureOrder,
  membershipHistoryNow,
  membershipHistoryScope,
} from './membership-bigquery-fixtures.js';
import {
  membershipSourceKey,
  publicationAuthority,
  warehouseCaptureFixture,
} from './membership-publication-fixtures.js';

const url = process.env.MEMBERSHIP_PUBLICATION_MYSQL_TEST_URL;
describe.skipIf(!url)('native source membership publication capture', () => {
  let f: Awaited<ReturnType<typeof membershipPublicationFixture>>;
  beforeAll(async () => {
    f = await membershipPublicationFixture(url!);
  });
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
  });
  afterEach(() => vi.restoreAllMocks());
  function options() {
    return {
      contract: csvMembershipNativeSnapshotContract,
      sourceSchema: f.schema,
      sourceServerUuid: f.sourceServerUuid,
      sourceTimeZone: 'Asia/Kolkata',
    } as const;
  }
  function publisher(db = f.db, patch: Partial<ReturnType<typeof options>> = {}) {
    return csvMembershipNativeSnapshot(
      db,
      { ...options(), ...patch },
      { sourceKey: membershipSourceKey, memberProductIds: ['10', '12'] },
      { clock: () => membershipHistoryNow - 2500 },
    );
  }
  it('reads only the identified source writer in an actual consistent READ ONLY snapshot and preserves exact IDs', async () => {
    const writer = f.db.get('writer'),
      get = vi.fn((name: Parameters<Databases['get']>[0]) =>
        name === 'writer' ? writer : f.db.get(name),
      );
    const transaction = vi.spyOn(snapshots, 'readMembershipSourceSnapshot');
    const capture = await publisher({ ...f.db, get }).capture(
      membershipHistoryScope,
      'c'.repeat(64),
    );
    expect(transaction).toHaveBeenCalledWith(writer.$client, expect.any(Function), {
      signal: expect.any(AbortSignal),
    });
    expect(get.mock.calls.map((args) => args[0])).toEqual(['writer']);
    expect(capture.selection.lastDeliveredOrder).toEqual(
      membershipBigQueryFixture([membershipFixtureOrder()]).selection.lastDeliveredOrder,
    );
    expect(capture.orderCount).toBe('1');
    expect(capture.lineCount).toBe('1');
    expect(capture.scope.customerId).toBe('9007199254740993');
    expect(
      verifyCsvMembershipSourceCapture(
        capture,
        membershipSourceKey,
        ['10', '12'],
        membershipHistoryNow,
      ),
    ).toEqual(capture);
  });
  it('database READ ONLY mode rejects a real attempted source write in the same capture transaction', async () => {
    const writer = f.db.get('writer'),
      original = snapshots.readMembershipSourceSnapshot;
    const run = async (
      pool: Parameters<typeof original>[0],
      callback: (tx: MySql2Database<Record<string, never>>) => Promise<unknown>,
      options?: Parameters<typeof original>[2],
    ) =>
      original(
        pool,
        async (tx) => {
          await expect(
            tx.execute(sql`UPDATE orders SET order_status=0 WHERE id=9007199254741001`),
          ).rejects.toMatchObject({
            cause: expect.objectContaining({ code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' }),
          });
          return callback(tx);
        },
        options,
      );
    vi.spyOn(snapshots, 'readMembershipSourceSnapshot').mockImplementation(run as typeof original);
    const capture = await publisher({
      ...f.db,
      get: (name) => (name === 'writer' ? writer : f.db.get(name)),
    }).capture(membershipHistoryScope, 'c'.repeat(64));
    expect(capture.orderCount).toBe('1');
    const [rows] = await f.admin.query('SELECT order_status AS status FROM orders');
    expect(rows).toEqual([expect.objectContaining({ status: 3 })]);
  });
  it('retains one native snapshot when a different connection commits between snapshot start and the business SELECTs', async () => {
    const writer = f.db.get('writer'),
      original = snapshots.readMembershipSourceSnapshot;
    let writes = 0;
    const run = async (
      pool: Parameters<typeof original>[0],
      callback: (tx: MySql2Database<Record<string, never>>) => Promise<unknown>,
      options?: Parameters<typeof original>[2],
    ) =>
      original(
        pool,
        async (tx) => {
          if (writes++ === 0) await f.admin.query('UPDATE has_products SET is_exclusive_order=0');
          return callback(tx);
        },
        options,
      );
    vi.spyOn(snapshots, 'readMembershipSourceSnapshot').mockImplementation(run as typeof original);
    const native = publisher({
      ...f.db,
      get: (name) => (name === 'writer' ? writer : f.db.get(name)),
    });
    const before = await native.capture(membershipHistoryScope, 'c'.repeat(64)),
      after = await native.capture(membershipHistoryScope, 'd'.repeat(64));
    expect(before.selection.lastDeliveredOrder!.lines[0]!.isExclusiveOrder).toBe(1);
    expect(after.selection.lastDeliveredOrder!.lines[0]!.isExclusiveOrder).toBe(0);
    expect(before.historyHash).not.toBe(after.historyHash);
  });
  it('captures native empty history explicitly and never queries a fallback replica', async () => {
    await f.admin.query('DELETE FROM has_products');
    await f.admin.query('DELETE FROM orders');
    const capture = await publisher().capture(membershipHistoryScope, 'c'.repeat(64));
    expect(capture.orderCount).toBe('0');
    expect(capture.selectedOrderCount).toBe('0');
    expect(capture.selection).toEqual({ lastDeliveredOrder: null, recentDeliveredOrders: [] });
  });
  it('derives the dispatch clock inside the source snapshot and rejects an older pre-connection second', async () => {
    let now = membershipHistoryNow - 2500;
    const original = snapshots.readMembershipSourceSnapshot;
    const run = async (
      pool: Parameters<typeof original>[0],
      read: (tx: MySql2Database<Record<string, never>>) => Promise<unknown>,
      opts?: Parameters<typeof original>[2],
    ) =>
      original(
        pool,
        async (tx) => {
          now += 1000;
          return read(tx);
        },
        opts,
      );
    vi.spyOn(snapshots, 'readMembershipSourceSnapshot').mockImplementation(run as typeof original);
    const source = csvMembershipNativeSnapshot(
      f.db,
      options(),
      { sourceKey: membershipSourceKey, memberProductIds: ['10', '12'] },
      { clock: () => now },
    );
    await expect(source.capture(membershipHistoryScope, 'c'.repeat(64))).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_CLOCK_CHANGED',
    });
    const captured = await source.captureForDispatch(membershipHistoryScope, 'd'.repeat(64));
    expect(captured.scope.asOf).toBe('2026-11-17 12:00:02');
    expect(captured.scope.cutoff).toBe('2026-10-03 12:00:02');
    expect(captured.capturedAt).toBe(membershipHistoryNow - 500);
  });
  it('preserves delivered-unpaid rows, exact45-day exclusion and old latest DCC', async () => {
    await f.admin.query('DELETE FROM has_products');
    await f.admin.query('DELETE FROM orders');
    const rows = [
      membershipFixtureOrder({
        createdAt: membershipHistoryScope.cutoff,
        paymentMethod: 10,
        paymentStatus: 0,
      }),
      membershipFixtureOrder({ id: '7', customerId: '8', lines: [] }),
      membershipFixtureOrder({ id: '9', orderStatus: 0, lines: [] }),
    ];
    await f.seed(rows);
    const capture = await publisher().capture(membershipHistoryScope, 'c'.repeat(64));
    expect(capture.orderCount).toBe('1');
    expect(capture.selection.lastDeliveredOrder?.paymentMethod).toBe(10);
    expect(capture.selection.recentDeliveredOrders).toEqual([]);
  });
  it('refuses source identity/schema mismatches and disabled selection before a financial stage exists', async () => {
    await expect(
      publisher(f.db, { sourceSchema: 'another_source' }).capture(
        membershipHistoryScope,
        'c'.repeat(64),
      ),
    ).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_IDENTITY_REQUIRED',
    });
    await expect(
      publisher(f.db, { sourceServerUuid: 'a971a320-1e04-4d1b-9bd8-6990ddcbca2d' }).capture(
        membershipHistoryScope,
        'c'.repeat(64),
      ),
    ).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_IDENTITY_REQUIRED',
    });
    const get = vi.spyOn(f.db, 'get'),
      disabled = csvMembershipNativeSnapshot(
        f.db,
        { ...options(), contract: undefined },
        { sourceKey: membershipSourceKey, memberProductIds: ['10'] },
        { clock: () => membershipHistoryNow - 2500 },
      );
    await expect(disabled.capture(membershipHistoryScope, 'c'.repeat(64))).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_REQUIRED',
    });
    expect(get).not.toHaveBeenCalled();
  });
  it('preserves future source rows because the literal membership queries have no upper date bound', async () => {
    await f.admin.query("UPDATE orders SET created_at='2026-11-17 12:00:01'");
    const capture = await publisher().capture(membershipHistoryScope, 'c'.repeat(64));
    expect(capture.orderCount).toBe('1');
    expect(capture.lineCount).toBe('1');
    expect(capture.selection.lastDeliveredOrder?.createdAt).toBe('2026-11-17 12:00:01');
    expect(capture.selection.recentDeliveredOrders.map((row) => row.createdAt)).toEqual([
      '2026-11-17 12:00:01',
    ]);
    expect(
      verifyCsvMembershipSourceCapture(
        capture,
        membershipSourceKey,
        ['10', '12'],
        membershipHistoryNow,
      ),
    ).toEqual(capture);
  });
  it('refuses source timestamp ties and mixed first-ordinary flags', async () => {
    await f.seed([membershipFixtureOrder({ id: '9007199254741003', lines: [] })]);
    await expect(publisher().capture(membershipHistoryScope, 'c'.repeat(64))).rejects.toMatchObject(
      { code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_AMBIGUOUS' },
    );
    await f.reset();
    await f.fixture.insert('has_products', {
      id: '9007199254741003',
      order_id: '9007199254741001',
      prod_id: '13',
      is_exclusive_order: 0,
    });
    await expect(publisher().capture(membershipHistoryScope, 'c'.repeat(64))).rejects.toMatchObject(
      { code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_SOURCE_AMBIGUOUS' },
    );
  });
  it('roundtrips actual native capture through independent warehouse qualification and produces a readable manifest', async () => {
    const rows = [membershipFixtureOrder()],
      capture = await publisher().capture(membershipHistoryScope, 'c'.repeat(64)),
      facts = warehouseCaptureFixture(capture, rows);
    const result = await sealCsvMembershipHistoryPublication(
      capture,
      { read: async () => facts },
      publicationAuthority,
      { sourceTimeZone: 'Asia/Kolkata', clock: () => membershipHistoryNow },
    );
    expect(result.publication.sourceHistoryHash).toBe(capture.historyHash);
    expect(result.publication.sourceComplete).toBe(true);
    facts.lines[0]!.isExclusiveOrder = 0;
    await expect(
      sealCsvMembershipHistoryPublication(
        capture,
        { read: async () => facts },
        publicationAuthority,
        { sourceTimeZone: 'Asia/Kolkata', clock: () => membershipHistoryNow },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INCOMPLETE' });
  });
});
