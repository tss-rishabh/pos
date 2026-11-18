import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dailyReportDates, cashLedgerDates } from '../../src/pages/finance/report-dates';
import { initialEntries, entriesSchema, type CloseState } from '../../src/pages/finance/model';
const source = JSON.parse(readFileSync(resolve('tests/finance/source-defaults.json'), 'utf8')) as {
  sourceCommit: string;
  cases: { at: string; range: string; selected: number[] }[];
};
const state: CloseState = {
  store_id: '1',
  close_date: '2026-11-18',
  tolerance: '0',
  close: null,
  window: {
    state: 'OPEN',
    allowed: true,
    override: null,
    message: '',
    opens_at: '',
    closes_at: '',
  },
  system: {
    order_count: 1,
    cash: '10',
    cash_refund: '0',
    card_upi: '2',
    online_other: '3',
    total_online: '5',
    district: '0',
    total_collection: '15',
  },
};
describe('pinned source report and close-entry contracts', () => {
  it('matches retained executed source GET/helper across midnight, month and year boundaries', () => {
    const values = source.cases;
    expect(values).toHaveLength(5);
    for (const value of values) {
      const dates = dailyReportDates(Date.parse(value.at));
      const display = (date: string) =>
        date.slice(5, 7) + '/' + date.slice(8, 10) + '/' + date.slice(0, 4);
      expect(display(dates.from) + ' - ' + display(dates.to)).toBe(value.range);
    }
    expect(dailyReportDates(Date.parse('2026-11-18T23:59:00+05:30'))).toEqual({
      from: '2026-11-13',
      to: '2026-11-19',
    });
  });
  it('requires all seven declarations and preserves saved revision zeroes', () => {
    const fresh = initialEntries(state);
    for (const field of [
      'cash_actual',
      'cash_manual_punched',
      'cash_manual_created',
      'card_actual',
      'card_manual_punched',
      'card_manual_created',
      'banking_amount',
    ] as const) {
      expect(fresh[field]).toBe('');
      expect(entriesSchema.safeParse({ ...fresh, [field]: '0' }).success).toBe(false);
    }
    const entered = {
      ...fresh,
      cash_actual: '0',
      cash_manual_punched: '0',
      cash_manual_created: '0',
      card_actual: '0',
      card_manual_punched: '0',
      card_manual_created: '0',
      banking_amount: '0',
    };
    expect(entriesSchema.safeParse(entered).success).toBe(true);
    const split = {
      system: '0',
      actual: '0',
      manual_punched: '0',
      manual_created: '0',
      difference: '0',
      reason: '' as const,
      comment: '',
    };
    expect(
      initialEntries({
        ...state,
        close: {
          version: 1,
          status: 'CLOSED',
          closed_at: '',
          closed_by_id: '1',
          stale_reason: null,
          cash: { ...split, refund: '0' },
          card: split,
          banking_amount: '0',
        },
      }),
    ).toEqual(entered);
  });
  it('initializes visible ledger dates in business time', () => {
    expect(cashLedgerDates(Date.parse('2026-02-28T23:59:59Z'))).toEqual({
      from: '2026-03-01',
      to: '2026-03-01',
    });
  });
});
