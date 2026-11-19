import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  canClose,
  cardDifference,
  cashDifference,
  closeEntriesSchema,
  defaultCloseDate,
  lastExpiredDate,
  discrepancyErrors,
  nagTargetDate,
  snapshotDrift,
  windowState,
  type ActiveClose,
  type CollectionSnapshot,
} from '../../src/modules/finance/domain.js';
import type { Role } from '../../src/domain/access.js';
import { goldenStdout } from '../golden/load.js';

const config = readConfig({
  NODE_ENV: 'test',
  MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
  SESSION_SECRET: 'finance-test-session-secret-'.repeat(2),
});
const legacyConfig = {
  DAY_CLOSE_OPEN_TIME: '22:00',
  DAY_CLOSE_CUTOFF_TIME: '21:00',
  DAY_CLOSE_CUTOFF_DAYS: 1,
  DAY_CLOSE_NAG_EVENING_START: '22:30',
  DAY_CLOSE_NAG_MORNING_START: '09:00',
  DAY_CLOSE_TOLERANCE: '0',
};
function oracle(value: unknown): unknown {
  return JSON.parse(goldenStdout('finance', 'domain', JSON.stringify(value)));
}
describe('day-close legacy policy and arithmetic parity', () => {
  it('matches all roles before/at/after the trading window, revisions and stale closes', () => {
    const cases = [];
    for (const role of [1, 2, 3, 4, 5] as Role[])
      for (const now of [
        '2026-11-16T21:59:59',
        '2026-11-16T22:00:00',
        '2026-11-16T22:30:00',
        '2026-11-17T08:59:59',
        '2026-11-17T09:00:00',
        '2026-11-17T21:00:00',
        '2026-11-17T21:00:01',
      ])
        for (const status of [null, 'CLOSED', 'STALE']) {
          const active: ActiveClose | null = status
            ? { status, closed_at: '2026-11-16T22:15:00', version: 1 }
            : null;
          cases.push({
            role,
            now,
            date: '2026-11-16',
            enabled: true,
            active,
            config: legacyConfig,
          });
        }
    cases.push({
      role: 1 as Role,
      now: '2026-11-16T23:00:00',
      date: '2026-11-16',
      enabled: false,
      active: null,
      config: legacyConfig,
    });
    const actual = cases.map((value) => {
      const now = Temporal.PlainDateTime.from(value.now)
        .toZonedDateTime(config.BUSINESS_TIMEZONE)
        .toInstant();
      return {
        permission: canClose(value.role, value.date, now, value.enabled, value.active, config),
        state: windowState(value.date, now, config),
        defaultDate: defaultCloseDate(now, config),
        nagDate: nagTargetDate(now, config),
        lastExpiredDate: lastExpiredDate(now, config),
      };
    });
    expect(actual).toEqual(oracle({ operation: 'policy', cases }));
  });
  it('matches exact decimal differences without floating point arithmetic', () => {
    const cases = Array.from({ length: 40 }, (_, i) => ({
      cash: [`${i * 100}.10`, '5.05', `${i * 90}.01`, '2.03', '1.99'],
      card: [`${i * 300}.77`, `${i * 290}.54`, '10.15', '2.01'],
    }));
    expect(
      cases.map((value) => ({
        cash: cashDifference(
          value.cash[0]!,
          value.cash[1]!,
          value.cash[2]!,
          value.cash[3]!,
          value.cash[4]!,
        ),
        card: cardDifference(value.card[0]!, value.card[1]!, value.card[2]!, value.card[3]!),
      })),
    ).toEqual(oracle({ operation: 'money', cases }));
  });
  it('rejects blank/manual/negative amounts and requires explanations only beyond tolerance', () => {
    const base = {
      cash_actual: '100.00',
      cash_manual_punched: '0',
      cash_manual_created: '0',
      card_actual: '20.00',
      card_manual_punched: '0',
      card_manual_created: '0',
      banking_amount: '0',
    };
    for (const invalid of ['', '-1', 'NaN', '1e3', '1.001'])
      expect(closeEntriesSchema.safeParse({ ...base, cash_actual: invalid }).success).toBe(false);
    const entries = closeEntriesSchema.parse(base),
      snapshot: CollectionSnapshot = {
        order_count: 1,
        cash: '100.00',
        cash_refund: '0.00',
        card_upi: '20.00',
        district: '0.00',
        online_other: '0.00',
        total_online: '20.00',
      };
    expect(discrepancyErrors(snapshot, entries, '0')).toEqual([]);
    expect(discrepancyErrors({ ...snapshot, cash: '100.01' }, entries, '0')).toEqual([
      'Select a reason for the cash difference.',
    ]);
    expect(discrepancyErrors({ ...snapshot, cash: '100.01' }, entries, '0.01')).toEqual([]);
    expect(
      discrepancyErrors(
        { ...snapshot, cash: '100.01' },
        { ...entries, cash_reason: 'CHANGE_SHORT' },
        '0',
      ),
    ).toEqual(['Add a comment on the cash difference.']);
    expect(
      snapshotDrift(
        { snap_order_count: 1, cash_system: '100', card_system: '20.0', cash_refund_system: '0' },
        snapshot,
      ),
    ).toBe(false);
    expect(
      snapshotDrift(
        { snap_order_count: 2, cash_system: '100', card_system: '20', cash_refund_system: '0' },
        snapshot,
      ),
    ).toBe(true);
  });
});
