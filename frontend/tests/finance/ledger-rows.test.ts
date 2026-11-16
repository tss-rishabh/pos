import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { selectLedgerRows, type LedgerRow } from '../../src/pages/finance/ledger-rows';
const row = (store: string, day: string, cash: string | null, note = ''): LedgerRow => ({
  store_id: store,
  store_name: 'Fixture ' + store,
  date: day,
  opening_cash: cash,
  sales_cash: '1.00',
  running_total: cash,
  actual_cash: cash,
  difference: '-1.00',
  banking_amount: '0.00',
  closing_balance: cash,
  status: cash === null ? 'OPEN_GAP' : 'CLOSED',
  note,
});
describe('cash-ledger display selection', () => {
  it('keeps full-chain balances unchanged while filtering/sorting exact money and paging stable rows', () => {
    const source = [
        row('1', '2026-11-01', '9007199254740993.00', 'Fixture note'),
        row('2', '2026-11-02', '-2.00'),
        row('3', '2026-11-03', '-10.00'),
        row('4', '2026-11-04', null),
        row('5', '2026-11-05', '9007199254740992.99'),
      ],
      snapshot = structuredClone(source);
    expect(
      selectLedgerRows(source, '', 'closing_balance', 'asc', 1, 2).data.map(
        (value) => value.store_id,
      ),
    ).toEqual(['4', '3']);
    expect(
      selectLedgerRows(source, '', 'closing_balance', 'desc', 1, 2).data.map(
        (value) => value.store_id,
      ),
    ).toEqual(['1', '5']);
    expect(selectLedgerRows(source, 'fixture NOTE', 'store_name', 'asc', 999, 50)).toMatchObject({
      total: 1,
      page: 1,
      totalPages: 1,
      data: [source[0]],
    });
    expect(selectLedgerRows(source, '-10.00', 'date', 'asc', 1, 25).data).toEqual([source[2]]);
    expect(source).toEqual(snapshot);
  });
  it('preserves the shipped DataTables smart-word and quoted-phrase search behavior', () => {
    const source = readFileSync(
        new URL(
          '../../../../backend-pos-web/static/adminlte/plugins/datatables/jquery.dataTables.js',
          import.meta.url,
        ),
        'utf8',
      ),
      start = source.indexOf('function _fnFilterCreateSearch'),
      end = source.indexOf('\n\t}', start) + 4,
      escapeStart = source.indexOf('_re_escape_regex =') + '_re_escape_regex ='.length,
      escapeEnd = source.indexOf(';', escapeStart),
      functionSource = source.slice(start, end),
      escapeSource = source.slice(escapeStart, escapeEnd),
      create: unknown = runInNewContext(
        `(function(){var _re_escape_regex=${escapeSource};function _fnEscapeRegex(val){return val.replace(_re_escape_regex,'\\\\$1');}${functionSource};return function(query){return _fnFilterCreateSearch(query,false,true,true).source;};})()`,
        { $: { map: (items: string[], map: (value: string) => string) => items.map(map) } },
      );
    if (typeof create !== 'function') throw new Error('Source search fixture unavailable.');
    const rows = [
      row('1', '2026-11-01', '10.00', 'blue cotton'),
      row('2', '2026-11-02', '20.00', 'cotton blue'),
      row('3', '2026-11-03', '30.00', 'literal a+b [x]'),
    ];
    for (const query of [
      'cotton blue',
      '"blue cotton"',
      '"cotton blue"',
      'Fixture 3',
      'a+b',
      '[x]',
      '^not-a-regex$',
      'cotton -1.00',
      '',
    ]) {
      const pattern: unknown = Reflect.apply(create, undefined, [query]);
      if (typeof pattern !== 'string') throw new Error('Source search pattern unavailable.');
      const expected = rows
        .filter((value) => new RegExp(pattern, 'i').test(Object.values(value).slice(1).join('  ')))
        .map((value) => value.store_id);
      expect(
        selectLedgerRows(rows, query, 'source', 'asc', 1, 50).data.map((value) => value.store_id),
      ).toEqual(expected);
    }
  });
});
