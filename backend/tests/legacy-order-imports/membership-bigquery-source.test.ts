import { describe, expect, it } from 'vitest';
import { csvMembershipBigQueryHistory } from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import {
  membershipBigQueryFixture,
  membershipFixtureOrder,
  membershipHistoryAuthority,
  membershipHistoryKey,
  membershipHistoryNow,
  membershipHistoryOptions,
  membershipHistoryScope,
} from './membership-bigquery-fixtures.js';
import { goldenSpawnResult } from '../golden/load.js';

describe('literal pinned AddFreeMembership criteria replay', () => {
  it('matches complete source SELECTs across inversion, DCC,45-day boundaries, unpaid and all-membership orders', async () => {
    const vectors = [
      { name: 'no-history', rows: [], eligible: false },
      { name: 'source-flag1-inverts-false', rows: [membershipFixtureOrder()], eligible: true },
      {
        name: 'source-flag0-inverts-true',
        rows: [
          membershipFixtureOrder({
            lines: [{ lineId: '2', productId: '11', isExclusiveOrder: 0 }],
          }),
        ],
        eligible: false,
      },
      {
        name: 'old-dcc-flag1',
        rows: [membershipFixtureOrder({ createdAt: '2020-01-01 00:00:00', paymentMethod: 10 })],
        eligible: true,
      },
      {
        name: 'old-dcc-flag0',
        rows: [
          membershipFixtureOrder({
            createdAt: '2020-01-01 00:00:00',
            paymentMethod: 10,
            lines: [{ lineId: '2', productId: '11', isExclusiveOrder: 0 }],
          }),
        ],
        eligible: false,
      },
      {
        name: 'exact-cutoff-not-recent',
        rows: [membershipFixtureOrder({ createdAt: membershipHistoryScope.cutoff })],
        eligible: false,
      },
      {
        name: 'one-second-inside',
        rows: [membershipFixtureOrder({ createdAt: '2026-10-03 12:00:01' })],
        eligible: true,
      },
      {
        name: 'unpaid-delivered-kept',
        rows: [membershipFixtureOrder({ paymentStatus: 0 })],
        eligible: true,
      },
      {
        name: 'undelivered-excluded',
        rows: [membershipFixtureOrder({ orderStatus: 1 })],
        eligible: false,
      },
      {
        name: 'foreign-customer-excluded',
        rows: [membershipFixtureOrder({ customerId: '2' })],
        eligible: false,
      },
      {
        name: 'latest-recent-only-inspected',
        rows: [
          membershipFixtureOrder({
            lines: [{ lineId: '2', productId: '11', isExclusiveOrder: 0 }],
          }),
          membershipFixtureOrder({ id: '3', createdAt: '2026-11-16 00:00:00' }),
        ],
        eligible: false,
      },
      {
        name: 'membership-products-skipped',
        rows: [
          membershipFixtureOrder({
            lines: [
              { lineId: '1', productId: '10', isExclusiveOrder: 0 },
              { lineId: '2', productId: '11', isExclusiveOrder: 1 },
            ],
          }),
        ],
        eligible: true,
      },
      {
        name: 'only-membership-source-default',
        rows: [
          membershipFixtureOrder({
            lines: [{ lineId: '1', productId: '10', isExclusiveOrder: 0 }],
          }),
        ],
        eligible: true,
      },
      {
        name: 'empty-hp-source-default',
        rows: [membershipFixtureOrder({ lines: [] })],
        eligible: true,
      },
      { name: 'old-cart-over2000-short-circuit', rows: [], cartValue: 2000.01, eligible: true },
      { name: 'exact2000-needs-history', rows: [], cartValue: 2000, eligible: false },
    ];
    const cases = [];
    for (const vector of vectors) {
      const fixture = membershipBigQueryFixture(vector.rows);
      const reader = csvMembershipBigQueryHistory(
        membershipHistoryOptions,
        membershipHistoryAuthority,
        {
          query: {
            estimate: async () => 0n,
            execute: async () => [{ document: JSON.stringify(fixture.envelope) }],
          },
          clock: () => membershipHistoryNow,
        },
      );
      cases.push({
        scope: membershipHistoryScope,
        document: await reader.read(membershipHistoryScope),
        all: vector.rows,
        cartValue: vector.cartValue ?? 1999,
      });
    }
    const result = goldenSpawnResult(
      'legacy-order-imports',
      'membership-bigquery-source',
      JSON.stringify({
        cases,
        key: membershipHistoryKey,
        memberProductIds: ['10', '12'],
        now: membershipHistoryNow,
      }),
    );
    expect(
      result.status,
      'Pinned source must run without database/network or code replacement.',
    ).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as {
      cases: { source: boolean; memory: boolean; same: boolean; sourceCalls: string[] }[];
      sourcePins: Record<string, string>;
    };
    expect(parsed.cases).toHaveLength(vectors.length);
    for (let index = 0; index < vectors.length; index++) {
      expect(parsed.cases[index], vectors[index]!.name).toMatchObject({
        source: vectors[index]!.eligible,
        memory: vectors[index]!.eligible,
        same: true,
      });
    }
    expect(parsed.cases.at(-2)!.sourceCalls).toEqual([]);
    expect(parsed.cases[10]!.sourceCalls).toEqual(['last', 'lines', 'recent', 'lines']);
    expect(parsed.sourcePins['controllers/cart/Cart.py']).toBe(
      '1f9eff0f1a4ea66f3cac8903d3c1cb9a5b39e2a3babd6dd6c8dcf192de7defd3',
    );
  });
});
