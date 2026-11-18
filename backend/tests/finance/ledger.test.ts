import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import {
  cashLedgerRows,
  ledgerBounds,
  type LedgerAnchor,
  type LedgerBanking,
  type LedgerClose,
  type LedgerSales,
  type LedgerStore,
} from '../../src/modules/finance/ledger.js';
import { goldenStdout } from '../golden/load.js';
interface Case {
  stores: LedgerStore[];
  anchors: LedgerAnchor[];
  closes: LedgerClose[];
  banking: LedgerBanking[];
  sales: LedgerSales[];
  from: string;
  to: string;
}
const close = (date: string, change: Partial<LedgerClose> = {}): LedgerClose => ({
  storeId: '1',
  date,
  version: 1,
  status: 'CLOSED',
  cashSystem: '100.10',
  cashRefund: '5.00',
  cashPunched: '0.10',
  cashCreated: '1.00',
  cashActual: '96.00',
  cashDifference: '0.00',
  banking: '40.00',
  ...change,
});
describe('cash ledger source parity', () => {
  it('matches original anchor resets, latest revisions, stale closes, banking override and unclosed-day stop', () => {
    const base: Case = {
      stores: [
        { id: '1', name: 'Fixture A' },
        { id: '2', name: 'Fixture B' },
      ],
      anchors: [{ storeId: '1', date: '2026-11-01', amount: '50.00' }],
      closes: [close('2026-11-01'), close('2026-11-02')],
      banking: [],
      sales: [{ storeId: '1', date: '2026-11-03', cash: '80.00', cashRefund: '5.00' }],
      from: '2026-11-01',
      to: '2026-11-03',
    };
    const cases: Case[] = [
      base,
      { ...base, banking: [{ storeId: '1', date: '2026-11-01', amount: '70.00' }] },
      {
        ...base,
        closes: [
          ...base.closes,
          close('2026-11-01', {
            version: 2,
            status: 'STALE',
            banking: '30.00',
            cashDifference: '-2.10',
          }),
        ],
      },
      { ...base, from: '2026-11-03', closes: [] },
      {
        ...base,
        anchors: [...base.anchors, { storeId: '1', date: '2026-11-03', amount: '200.00' }],
        closes: [],
        from: '2026-11-02',
      },
      { ...base, anchors: [] },
      {
        ...base,
        anchors: [{ storeId: '1', date: '2026-11-02', amount: '100.00' }],
        closes: [close('2026-11-02')],
      },
    ];
    const expected: unknown = JSON.parse(
      goldenStdout('finance', 'ledger', JSON.stringify({ cases })),
    );
    expect(
      cases.map((test) =>
        cashLedgerRows(
          test.stores,
          test.anchors,
          test.closes,
          test.banking,
          test.sales,
          test.from,
          test.to,
        ),
      ),
    ).toEqual(expected);
  });
  it('preserves calendar bounds and clamps future To dates', () => {
    const now = Temporal.Instant.from('2026-11-16T08:00:00Z');
    expect(ledgerBounds(undefined, undefined, now, 'Asia/Kolkata')).toEqual({
      from: '2026-11-01',
      to: '2026-11-16',
      today: '2026-11-16',
    });
    expect(ledgerBounds('2026-11-15', '2026-12-30', now, 'Asia/Kolkata').to).toBe('2026-11-16');
    expect(() => ledgerBounds('2026-11-17', undefined, now, 'Asia/Kolkata')).toThrow('future');
    expect(() => ledgerBounds('2024-01-01', undefined, now, 'Asia/Kolkata')).toThrow('366');
  });
});
