import { describe, expect, it, vi } from 'vitest';
import {
  assertCsvMembershipPrefetch,
  inMemoryCsvMembershipHistory,
  prefetchCsvMembershipHistory,
  requestForCsvMembershipDispatch,
} from '../../src/modules/legacy-order-imports/membership-profile/bridge.js';
import { csvMembershipBigQueryHistory } from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import {
  membershipBigQueryFixture,
  membershipHistoryAuthority,
  membershipHistoryKey,
  membershipHistoryNow,
  membershipHistoryOptions,
  membershipHistoryScope,
} from './membership-bigquery-fixtures.js';

const options = {
  historyKey: membershipHistoryKey,
  memberProductIds: ['10', '12'],
  sourceTimeZone: 'Asia/Kolkata',
  clock: () => membershipHistoryNow,
};
async function prepared() {
  const execute = vi.fn(async () => [
    { document: JSON.stringify(membershipBigQueryFixture().envelope) },
  ]);
  const reader = csvMembershipBigQueryHistory(
    membershipHistoryOptions,
    membershipHistoryAuthority,
    { query: { estimate: async () => 1n, execute }, clock: options.clock },
  );
  const handoff = await prefetchCsvMembershipHistory(reader, membershipHistoryScope, options);
  return { handoff, execute };
}
describe('pre-dispatch history sealing and transaction-local replay', () => {
  it('captures the literal execution wall second and45calendar-day cutoff, independently from old CSV dates', () => {
    expect(
      requestForCsvMembershipDispatch(membershipHistoryScope, {
        sourceTimeZone: 'Asia/Kolkata',
        clock: () => Date.parse('2026-11-17T06:30:00.999Z'),
      }),
    ).toEqual(membershipHistoryScope);
    const leap = requestForCsvMembershipDispatch(membershipHistoryScope, {
      sourceTimeZone: 'Asia/Kolkata',
      clock: () => Date.parse('2024-03-01T06:30:00Z'),
    });
    expect(leap.asOf).toBe('2024-03-01 12:00:00');
    expect(leap.cutoff).toBe('2024-01-16 12:00:00');
    // DST is a wall-calendar subtraction, not45*24elapsed hours.
    const dst = requestForCsvMembershipDispatch(membershipHistoryScope, {
      sourceTimeZone: 'America/New_York',
      clock: () => Date.parse('2026-03-20T16:00:00Z'),
    });
    expect(dst.asOf).toBe('2026-03-20 12:00:00');
    expect(dst.cutoff).toBe('2026-02-03 12:00:00');
  });
  it('prefetches before dispatch, freezes the document/capability and replays memory only under a no-I/O transaction boundary', async () => {
    const f = await prepared(),
      memory = inMemoryCsvMembershipHistory(f.handoff, options);
    expect(Object.isFrozen(f.handoff)).toBe(true);
    expect(Object.isFrozen(f.handoff.document.recentDeliveredOrders[0]!.lines)).toBe(true);
    f.execute.mockRejectedValue(new Error('SQL_TX_NETWORK_FORBIDDEN'));
    const first = await memory.read(membershipHistoryScope),
      second = await memory.read(membershipHistoryScope);
    expect(first).toEqual(f.handoff.document);
    expect(second).toEqual(first);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.handoff.capability.expiresAt).toBe(Date.parse('2026-11-17T06:31:00Z'));
  });
  it.each(['operationId', 'requestHash', 'planHash', 'customerId', 'asOf', 'cutoff'])(
    'refuses replay into a different %s even with a valid original document signature',
    async (field) => {
      const f = await prepared(),
        memory = inMemoryCsvMembershipHistory(f.handoff, options);
      const input = {
        ...membershipHistoryScope,
        [field]:
          field === 'operationId'
            ? 'bb127f8c-6fbb-41eb-a608-9115b3e31561'
            : field.endsWith('Hash')
              ? 'f'.repeat(64)
              : field === 'customerId'
                ? '99'
                : '2026-11-17 12:00:01',
      };
      await expect(memory.read(input)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID',
      });
    },
  );
  it('rejects tampered generation, document digest, expiry, time zone and capability proof', async () => {
    const f = await prepared();
    for (const change of [
      { generationId: 'd'.repeat(64) },
      { documentHash: 'd'.repeat(64) },
      { expiresAt: membershipHistoryNow + 60000 },
      { sourceTimeZone: 'UTC' },
      { signature: 'd'.repeat(64) },
    ]) {
      const value = structuredClone(f.handoff);
      Object.assign(value.capability, change);
      expect(() => assertCsvMembershipPrefetch(value, membershipHistoryScope, options)).toThrow(
        expect.objectContaining({ code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID' }),
      );
    }
    const changed = structuredClone(f.handoff);
    changed.document.lastDeliveredOrder!.lines[0]!.isExclusiveOrder = 0;
    expect(() => inMemoryCsvMembershipHistory(changed, options)).toThrow(
      expect.objectContaining({ code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID' }),
    );
  });
  it('never extends the original expiry during replay or source retry', async () => {
    const f = await prepared();
    let now = membershipHistoryNow;
    const memory = inMemoryCsvMembershipHistory(f.handoff, { ...options, clock: () => now });
    now = f.handoff.capability.expiresAt - 1;
    expect((await memory.read(membershipHistoryScope)).fetchedAt).toBe(membershipHistoryNow);
    now++;
    await expect(memory.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID',
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('copies mutable supplied data and refuses missing/invalid handoff instead of querying or returning empty history', async () => {
    const f = await prepared(),
      wire = structuredClone(f.handoff),
      memory = inMemoryCsvMembershipHistory(wire, options);
    wire.document.generationId = 'd'.repeat(64);
    expect((await memory.read(membershipHistoryScope)).generationId).toBe('c'.repeat(64));
    for (const value of [null, {}, [], { document: f.handoff.document }])
      expect(() => inMemoryCsvMembershipHistory(value, options)).toThrow();
  });
  it('rejects invalid clocks and DST-ambiguous source seconds', () => {
    for (const clock of [() => NaN, () => -1, () => Infinity])
      expect(() =>
        requestForCsvMembershipDispatch(membershipHistoryScope, {
          sourceTimeZone: 'Asia/Kolkata',
          clock,
        }),
      ).toThrow();
    expect(() =>
      requestForCsvMembershipDispatch(membershipHistoryScope, {
        sourceTimeZone: 'America/New_York',
        clock: () => Date.parse('2026-11-01T05:30:00Z'),
      }),
    ).toThrow();
  });
});
