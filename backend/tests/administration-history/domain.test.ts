import { execFileSync } from 'node:child_process';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  historyInput,
  readAdministrationHistoryOptions,
} from '../../src/modules/administration-history/contracts.js';
import {
  historyReadScope,
  sourceHistoryDateLabel,
  sourceHistoryPage,
} from '../../src/modules/administration-history/domain.js';

describe('source Django history paging and date contract', () => {
  it('matches the actual fixed100-row paginator including empty, invalid, unicode and last-page fallback cases', () => {
    const cases = [0, 1, 99, 100, 101, 201].flatMap((total) =>
      [
        '1',
        '2',
        '0',
        '-1',
        '99999999999999999999',
        'invalid',
        '',
        '  +2  ',
        '1_0',
        '1__0',
        '１',
        '٢',
        '\u00852\u001f',
        '\ufeff2',
        '2.0',
        '+_2',
        1,
        1.2,
      ].map((page) => ({ operation: 'page', page, total })),
    );
    const expected = oracle(cases);
    cases.forEach((value, index) => {
      const result = sourceHistoryPage(value.page, BigInt(value.total));
      expect(
        {
          ...result,
          page: Number(result.page),
          pages: Number(result.pages),
          start: Number(result.start),
        },
        `source page case ${index}`,
      ).toEqual(expected[index]);
    });
  });
  it('matches en-us wall datetime labels without timezone reinterpretation', () => {
    const dates = [
      '2026-01-01 00:00:00.000000',
      '2026-02-02 12:00:01.123456',
      '2026-03-03 01:00:00',
      '2026-04-04 13:01:59',
      '2026-05-05 23:59:59',
      '2026-06-06 00:01:00',
      '2026-07-07 12:05:00',
      '2026-08-08 09:02:00',
      '2026-09-09 18:00:00',
      '2026-10-10 10:00:00',
      '2026-11-16 17:30:00',
      '2026-12-31 23:00:00',
    ];
    const expected = oracle(dates.map((value) => ({ operation: 'date', value })));
    dates.forEach((date, index) => expect(sourceHistoryDateLabel(date)).toBe(expected[index]));
  });
  it('uses the data reader only for exactly the current business day and never for all history', () => {
    const now = Temporal.Instant.from('2026-11-15T20:00:00Z');
    for (const [from, to, reader] of [
      [null, null, 'bigquery'],
      ['2026-11-16', '2026-11-16', 'data-reader'],
      ['2026-11-15', '2026-11-16', 'bigquery'],
      ['2026-11-17', '2026-11-17', 'bigquery'],
    ] as const) {
      const scope = historyReadScope(
        { BUSINESS_TIMEZONE: 'Asia/Kolkata' },
        historyInput.parse({ model: 'operator', objectId: '1', from, to }),
        now,
      );
      expect(scope.reader).toBe(reader);
      expect(scope.today).toBe('2026-11-16');
    }
  });
  it('strictly validates object keys, date pairs, source contracts and deployment identifiers', () => {
    for (const value of [
      { model: 'operator', objectId: '01' },
      { model: 'group', objectId: '1' },
      { model: 'store', objectId: '1', from: '2026-11-16' },
      { model: 'store', objectId: '1', from: '2026-11-17', to: '2026-11-16' },
      { model: 'operator', objectId: '1', search: 'private' },
    ])
      expect(historyInput.safeParse(value).success).toBe(false);
    expect(historyInput.parse({ model: 'operator', objectId: '9007199254740993' }).objectId).toBe(
      '9007199254740993',
    );
    expect(() =>
      readAdministrationHistoryOptions({
        BQ_ADMINISTRATION_HISTORY_VIEW: 'project.dataset.view; DROP',
      }),
    ).toThrow();
    expect(() =>
      readAdministrationHistoryOptions({ POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR: 'auto' }),
    ).toThrow();
    expect(
      readAdministrationHistoryOptions({
        POS_ADMINISTRATION_HISTORY_MYSQL_CONTRACT: '',
        BQ_ADMINISTRATION_HISTORY_VIEW: '',
      }),
    ).toEqual({
      POS_ADMINISTRATION_HISTORY_MYSQL_CONTRACT: undefined,
      BQ_ADMINISTRATION_HISTORY_VIEW: undefined,
    });
  });
});
function oracle(cases: unknown[]) {
  return z
    .object({ djangoVersion: z.literal('4.2.5'), cases: z.array(z.unknown()) })
    .parse(
      JSON.parse(
        execFileSync(
          'uv',
          [
            'run',
            '--no-project',
            '--with',
            'django==4.2.5',
            'python',
            'tools/administration-history/source-oracle.py',
          ],
          { encoding: 'utf8', timeout: 30000, input: JSON.stringify({ cases }) },
        ),
      ) as unknown,
    ).cases;
}
