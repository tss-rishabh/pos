import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  csvMembershipBigQueryHistory,
  csvMembershipBigQueryContract,
  csvMembershipHistorySql,
  readCsvMembershipBigQueryOptions,
  type CsvMembershipHistoryQueryPort,
  type CsvMembershipHistoryStatement,
} from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import { assertQualifiedCsvMembershipHistory } from '../../src/modules/legacy-order-imports/membership-profile/history.js';
import {
  membershipBigQueryFixture,
  membershipFixtureOrder,
  membershipHistoryAuthority,
  membershipHistoryKey,
  membershipHistoryNow,
  membershipHistoryOptions,
  membershipHistoryScope,
  resealMembershipPublication,
} from './membership-bigquery-fixtures.js';

function setup(fixture = membershipBigQueryFixture(), options = membershipHistoryOptions) {
  const estimate = vi.fn(async () => 1n),
    execute = vi.fn(async (_request: CsvMembershipHistoryStatement, _signal?: AbortSignal) => [
      { document: JSON.stringify(fixture.envelope) },
    ]);
  const query: CsvMembershipHistoryQueryPort = { estimate, execute };
  return {
    fixture,
    estimate,
    execute,
    read: csvMembershipBigQueryHistory(options, membershipHistoryAuthority, {
      query,
      clock: () => membershipHistoryNow,
    }),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('qualified read-only CSV membership history', () => {
  it('seals exact IDs and operation/plan/customer/time/generation after one dry-run and bounded generation read', async () => {
    const f = setup(),
      result = await f.read.read(membershipHistoryScope);
    expect(result).toMatchObject({
      scope: membershipHistoryScope,
      reader: 'bigquery',
      complete: true,
      generationId: 'c'.repeat(64),
      ...f.fixture.selection,
    });
    expect(result.recentDeliveredOrders[0]!.id).toBe('9007199254741001');
    expect(result.recentDeliveredOrders[0]!.lines[0]!.lineId).toBe('9007199254741002');
    expect(result.recentDeliveredOrders[0]!.lines[0]!.isExclusiveOrder).toBe(1);
    expect(
      assertQualifiedCsvMembershipHistory(
        result,
        membershipHistoryScope,
        membershipHistoryKey,
        ['10', '12'],
        membershipHistoryNow,
      ),
    ).toEqual(result);
    expect(f.estimate).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    const query = f.execute.mock.calls[0]![0];
    expect(query).toEqual(
      csvMembershipHistorySql(membershipHistoryOptions, membershipHistoryScope),
    );
    expect(query.statement).not.toContain(membershipHistoryScope.customerId);
    expect(query.statement).toContain('o.order_status=3');
    expect(query.statement).not.toMatch(
      /payment_status|orders.+created_at<=@asOf|\b(?:INSERT|UPDATE|DELETE|MERGE|EXPORT|CREATE)\b/i,
    );
    expect(query.statement).toContain('LIMIT @orderTake');
    expect(query.statement).toContain('LIMIT @lineTake');
    expect(query.statement).toContain('SUBSTR(order_id,1,20) AS id');
    expect(query.statement).toContain('SUBSTR(line_id,1,20) AS lineId');
    expect(query.statement).toContain('SUBSTR(signature,1,65) AS signature');
    expect(query.types).toMatchObject({ asOf: 'DATETIME', cutoff: 'DATETIME', customer: 'STRING' });
  });
  it('proves absence through an independent signed complete generation instead of treating missing publication as no orders', async () => {
    const empty = setup(membershipBigQueryFixture([])),
      result = await empty.read.read(membershipHistoryScope);
    expect(result.lastDeliveredOrder).toBeNull();
    expect(result.recentDeliveredOrders).toEqual([]);
    empty.fixture.envelope.publications = [];
    await expect(empty.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_PUBLICATION_REQUIRED',
    });
  });
  it('keeps an all-time last order exactly on the exclusive45-day boundary while recent stays empty', async () => {
    const f = setup(
      membershipBigQueryFixture([
        membershipFixtureOrder({ createdAt: membershipHistoryScope.cutoff, paymentMethod: 10 }),
      ]),
    );
    const result = await f.read.read(membershipHistoryScope);
    expect(result.lastDeliveredOrder?.createdAt).toBe(membershipHistoryScope.cutoff);
    expect(result.recentDeliveredOrders).toEqual([]);
  });
  it('does not add a paid-status predicate or include another customer or non-delivered order', async () => {
    const f = setup(
      membershipBigQueryFixture([
        membershipFixtureOrder({ paymentStatus: 0 }),
        membershipFixtureOrder({
          id: '5',
          customerId: '4',
          createdAt: membershipHistoryScope.asOf,
        }),
        membershipFixtureOrder({ id: '6', orderStatus: 0, createdAt: membershipHistoryScope.asOf }),
      ]),
    );
    const result = await f.read.read(membershipHistoryScope);
    expect(result.recentDeliveredOrders).toHaveLength(1);
    expect(result.recentDeliveredOrders[0]!.paymentMethod).toBe(14);
  });
  it.each([
    'customerId',
    'asOf',
    'cutoff',
    'sourceTimeZone',
    'generationId',
    'sourceHistoryHash',
    'sourceComplete',
  ])('refuses tampered publication %s without substituting history', async (field) => {
    const f = setup();
    Object.assign(f.fixture.envelope.publications[0]!, {
      [field]: field === 'sourceComplete' ? false : 'tampered',
    });
    await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: expect.stringMatching(/^ORDER_IMPORT_MEMBERSHIP_HISTORY_/),
    });
  });
  it.each([
    'orders',
    'uniqueOrders',
    'selectedOrders',
    'uniqueSelectedOrders',
    'lines',
    'uniqueLines',
    'invalidOrders',
    'latestTies',
    'foreignLines',
  ])(
    'refuses incomplete or ambiguous observed %s even when the warehouse manifest says complete',
    async (field) => {
      const f = setup();
      Object.assign(f.fixture.envelope.actual, { [field]: '7' });
      await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INCOMPLETE',
      });
    },
  );
  it.each([
    'sourceOrderCount',
    'warehouseOrderCount',
    'sourceSelectedOrderCount',
    'warehouseSelectedOrderCount',
    'sourceLineCount',
    'warehouseLineCount',
  ])('checks independently sealed %s against the actual bounded result', async (field) => {
    const f = setup();
    Object.assign(f.fixture.envelope.publications[0]!, { [field]: '99' });
    resealMembershipPublication(f.fixture.envelope.publications[0]!);
    await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INCOMPLETE',
    });
  });
  it('refuses altered projected line contents even with unchanged counts', async () => {
    const f = setup();
    f.fixture.envelope.lines[0]!.isExclusiveOrder = 0;
    await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INCOMPLETE',
    });
  });
  it('rejects source-ambiguous same-time orders and mixed ordinary exclusive flags rather than choosing a first row', async () => {
    const tied = setup(
      membershipBigQueryFixture([
        membershipFixtureOrder(),
        membershipFixtureOrder({ id: '2', lines: [] }),
      ]),
    );
    await expect(tied.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_AMBIGUOUS',
    });
    const mixed = setup(
      membershipBigQueryFixture([
        membershipFixtureOrder({
          lines: [
            { lineId: '1', productId: '11', isExclusiveOrder: 1 },
            { lineId: '2', productId: '13', isExclusiveOrder: 0 },
          ],
        }),
      ]),
    );
    await expect(mixed.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
  });
  it('accepts different membership-line flags when all ordinary flags agree', async () => {
    const f = setup(
      membershipBigQueryFixture([
        membershipFixtureOrder({
          lines: [
            { lineId: '2', productId: '10', isExclusiveOrder: 0 },
            { lineId: '1', productId: '11', isExclusiveOrder: 1 },
          ],
        }),
      ]),
    );
    expect(
      (await f.read.read(membershipHistoryScope)).lastDeliveredOrder?.lines.map(
        (row) => row.lineId,
      ),
    ).toEqual(['1', '2']);
  });
  it.each(['sourceSnapshotAt', 'sourceCdcThrough', 'publishedAt'])(
    'refuses stale or incoherent publication time %s',
    async (field) => {
      const f = setup();
      Object.assign(f.fixture.envelope.publications[0]!, { [field]: '2026-11-17T06:00:00Z' });
      resealMembershipPublication(f.fixture.envelope.publications[0]!);
      await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
      });
    },
  );
  it('refuses duplicate publications, invalid result wire and truncated row bounds', async () => {
    const dup = setup();
    dup.fixture.envelope.publications.push({ ...dup.fixture.envelope.publications[0]! });
    await expect(dup.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
    const row = setup();
    row.fixture.envelope.orders.push({ ...row.fixture.envelope.orders[0]! });
    await expect(row.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INCOMPLETE',
    });
    const limited = setup(membershipBigQueryFixture(), {
      ...membershipHistoryOptions,
      CSV_MEMBERSHIP_MAX_ORDERS: 1,
    });
    await expect(limited.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
    const malformed = setup();
    malformed.execute.mockResolvedValue([{ document: 'not JSON' }]);
    await expect(malformed.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
  });
  it.each([-1n, 50000001n])(
    'refuses an unqualified %s byte dry-run before execution',
    async (bytes) => {
      const f = setup();
      f.estimate.mockResolvedValue(bytes);
      await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_BUDGET',
      });
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it('bounds both estimate and execution by one deadline and ignores late completion', async () => {
    vi.useFakeTimers();
    const f = setup(membershipBigQueryFixture(), {
      ...membershipHistoryOptions,
      CSV_MEMBERSHIP_QUERY_TIMEOUT_MS: 100,
    });
    f.estimate.mockImplementation(() => new Promise<bigint>(() => undefined));
    const task = expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(101);
    await task;
    expect(f.execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not disclose SDK errors or configuration values', async () => {
    const f = setup();
    f.execute.mockRejectedValue(
      new Error('PII_CANARY private@example.test SQL password KEY_BYTES'),
    );
    try {
      await f.read.read(membershipHistoryScope);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_UNAVAILABLE' });
      expect(String(error)).not.toMatch(/PII_CANARY|private@|SQL|password|KEY_BYTES/);
    }
    expect(() =>
      readCsvMembershipBigQueryOptions({
        BQ_CSV_MEMBERSHIP_ORDERS_VIEW: 'private-canary.invalid.table',
      }),
    ).toThrow(expect.objectContaining({ code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_CONFIGURATION' }));
  });
  it('defaults disabled and never initializes SDK without complete allowed configuration', async () => {
    const factory = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    const reader = csvMembershipBigQueryHistory(
      readCsvMembershipBigQueryOptions({}),
      membershipHistoryAuthority,
      { clientFactory: factory },
    );
    await expect(reader.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED',
    });
    expect(factory).not.toHaveBeenCalled();
    for (const field of [
      'BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW',
      'BQ_CSV_MEMBERSHIP_ORDERS_VIEW',
      'BQ_CSV_MEMBERSHIP_LINES_VIEW',
    ])
      expect(() =>
        readCsvMembershipBigQueryOptions({ [field]: 'other-project.other_dataset.table' }),
      ).toThrow();
    expect(readCsvMembershipBigQueryOptions({}).CSV_MEMBERSHIP_BIGQUERY_CONTRACT).toBeUndefined();
    expect(membershipHistoryOptions.CSV_MEMBERSHIP_BIGQUERY_CONTRACT).toBe(
      csvMembershipBigQueryContract,
    );
  });
  it('accepts empty unselected environment placeholders without initializing the reader', () => {
    expect(
      readCsvMembershipBigQueryOptions({
        CSV_MEMBERSHIP_BIGQUERY_CONTRACT: '',
        BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW: '',
        BQ_CSV_MEMBERSHIP_ORDERS_VIEW: '',
        BQ_CSV_MEMBERSHIP_LINES_VIEW: '',
        CSV_MEMBERSHIP_SOURCE_TIMEZONE: '',
      }).CSV_MEMBERSHIP_BIGQUERY_CONTRACT,
    ).toBeUndefined();
  });
  it.each(['not a calendar date', '2026-02-30 12:00:00', 'PII_CANARY@example.test'])(
    'classifies a malformed source execution clock without leaking the value',
    async (asOf) => {
      const f = setup();
      try {
        await f.read.read({ ...membershipHistoryScope, asOf });
        throw new Error('accepted');
      } catch (error) {
        expect(error).toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID' });
        expect(String(error)).not.toContain(asOf);
      }
      expect(f.estimate).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it('rejects a source snapshot with a one-microsecond different cut rather than rounding its proof time', async () => {
    const f = setup();
    f.fixture.envelope.publications[0]!.sourceSnapshotAt = '2026-11-17T06:30:00.000001Z';
    resealMembershipPublication(f.fixture.envelope.publications[0]!);
    await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
  });
  it('rejects stale/future source clocks before query estimation', async () => {
    for (const now of [membershipHistoryNow + 60000, membershipHistoryNow - 4000]) {
      const f = setup(),
        reader = csvMembershipBigQueryHistory(
          membershipHistoryOptions,
          membershipHistoryAuthority,
          { query: { estimate: f.estimate, execute: f.execute }, clock: () => now },
        );
      await expect(reader.read(membershipHistoryScope)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_STALE',
      });
      expect(f.estimate).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('bounds raw wire bytes and complete nested document bytes', async () => {
    const wire = setup();
    wire.execute.mockResolvedValue([{ document: 'x'.repeat(2000001) }]);
    await expect(wire.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
    const large = setup(
      membershipBigQueryFixture([
        membershipFixtureOrder({
          lines: Array.from({ length: 8000 }, (_, index) => ({
            lineId: String(9007199254741000n + BigInt(index)),
            productId: '9007199254740993',
            isExclusiveOrder: 1 as const,
          })),
        }),
      ]),
    );
    expect(Buffer.byteLength(JSON.stringify(large.fixture.selection))).toBeGreaterThan(1000000);
    const outcome = await large.read.read(membershipHistoryScope).then(
      () => ({ code: 'accepted' }),
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
  });
  it('never accepts a nonempty source count with an invented empty latest/recent selection', async () => {
    const f = setup(membershipBigQueryFixture([]));
    f.fixture.envelope.actual.orders = '1';
    f.fixture.envelope.actual.uniqueOrders = '1';
    f.fixture.envelope.actual.latestTies = '1';
    f.fixture.envelope.publications[0]!.sourceOrderCount = '1';
    f.fixture.envelope.publications[0]!.warehouseOrderCount = '1';
    resealMembershipPublication(f.fixture.envelope.publications[0]!);
    await expect(f.read.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INCOMPLETE',
    });
  });
});
