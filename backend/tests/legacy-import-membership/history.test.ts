import { describe, expect, it } from 'vitest';
import {
  assertQualifiedCsvMembershipHistory,
  csvMembershipHistoryContract,
  csvMembershipHistoryHash,
  csvMembershipHistoryRequestSchema,
  qualifiedCsvMembershipHistorySchema,
} from '../../src/modules/legacy-order-imports/membership-profile/history.js';
const key = 'isolated-purpose-specific-membership-history-key-012345',
  now = 1781524800000;
const scope = csvMembershipHistoryRequestSchema.parse({
  contract: csvMembershipHistoryContract,
  operationId: '5a5d1efb-727e-45ea-b214-9136be787031',
  requestHash: 'b'.repeat(64),
  planHash: 'c'.repeat(64),
  customerId: '77',
  asOf: '2026-06-15 12:00:00',
  cutoff: '2026-05-01 12:00:00',
});
function fixture() {
  const row = {
    id: '9007199254740993',
    paymentMethod: 14,
    createdAt: '2026-06-01 12:00:00',
    lines: [{ lineId: '9007199254740994', productId: '11', isExclusiveOrder: 1 as const }],
  };
  const body = {
    scope,
    reader: 'bigquery' as const,
    generationId: 'a'.repeat(64),
    complete: true as const,
    fetchedAt: now,
    lastDeliveredOrder: row,
    recentDeliveredOrders: [row],
  };
  return qualifiedCsvMembershipHistorySchema.parse({
    ...body,
    signature: csvMembershipHistoryHash(body, key),
  });
}
describe('CSV membership qualified history port', () => {
  it('preserves exact unsafe-integer IDs and signed absence', () => {
    expect(
      assertQualifiedCsvMembershipHistory(fixture(), scope, key, ['10'], now).lastDeliveredOrder
        ?.id,
    ).toBe('9007199254740993');
    const { signature: _seal, ...body } = fixture();
    const absent = { ...body, lastDeliveredOrder: null, recentDeliveredOrders: [] };
    expect(
      assertQualifiedCsvMembershipHistory(
        { ...absent, signature: csvMembershipHistoryHash(absent, key) },
        scope,
        key,
        ['10'],
        now,
      ).lastDeliveredOrder,
    ).toBeNull();
  });
  it('validates HMAC before treating history as authoritative', () => {
    const facts = fixture();
    facts.lastDeliveredOrder!.lines[0]!.isExclusiveOrder = 0;
    expect(() => assertQualifiedCsvMembershipHistory(facts, scope, key, ['10'], now)).toThrow();
  });
  it('does not accept another customer, operation or plan even if validly signed', () => {
    for (const field of ['customerId', 'operationId', 'planHash'] as const) {
      const { signature: _seal, ...body } = fixture();
      const changed = {
        ...body,
        scope: {
          ...scope,
          [field]:
            field === 'operationId'
              ? '6a5d1efb-727e-45ea-b214-9136be787031'
              : field === 'customerId'
                ? '88'
                : 'd'.repeat(64),
        },
      };
      expect(() =>
        assertQualifiedCsvMembershipHistory(
          { ...changed, signature: csvMembershipHistoryHash(changed, key) },
          scope,
          key,
          ['10'],
          now,
        ),
      ).toThrow();
    }
  });
  it('refuses stale/future, partial and missing generation proofs', () => {
    for (const kind of ['stale', 'future', 'partial', 'generation']) {
      const { signature: _seal, ...base } = fixture();
      const body: Record<string, unknown> = { ...base };
      if (kind === 'stale') body.fetchedAt = now - 60001;
      if (kind === 'future') body.fetchedAt = now + 1;
      if (kind === 'partial') body.complete = false;
      if (kind === 'generation') body.generationId = '';
      expect(() =>
        assertQualifiedCsvMembershipHistory(
          { ...body, signature: 'a'.repeat(64) },
          scope,
          key,
          ['10'],
          now,
        ),
      ).toThrow();
    }
  });
  it('refuses mixed unordered HP entitlement flags and tied delivered dates', () => {
    const body = fixture();
    body.lastDeliveredOrder!.lines.push({
      lineId: '9007199254740995',
      productId: '12',
      isExclusiveOrder: 0,
    });
    const { signature: _seal, ...mixed } = body;
    expect(() =>
      assertQualifiedCsvMembershipHistory(
        { ...mixed, signature: csvMembershipHistoryHash(mixed, key) },
        scope,
        key,
        ['10'],
        now,
      ),
    ).toThrow();
    const { signature: _other, ...tied } = fixture();
    tied.recentDeliveredOrders.push({ ...tied.recentDeliveredOrders[0]!, id: '9007199254740997' });
    expect(() =>
      assertQualifiedCsvMembershipHistory(
        { ...tied, signature: csvMembershipHistoryHash(tied, key) },
        scope,
        key,
        ['10'],
        now,
      ),
    ).toThrow();
  });
  it('retains source strict 45-day boundary and latest-order coherence', () => {
    const { signature: _seal, ...body } = fixture();
    body.recentDeliveredOrders = [];
    expect(() =>
      assertQualifiedCsvMembershipHistory(
        { ...body, signature: csvMembershipHistoryHash(body, key) },
        scope,
        key,
        ['10'],
        now,
      ),
    ).toThrow();
    expect(() =>
      csvMembershipHistoryRequestSchema.parse({ ...scope, cutoff: '2026-05-02 12:00:00' }),
    ).toThrow();
  });
});
