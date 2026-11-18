import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import {
  sourceOrderDefaults,
  sourceSearchReadPlan,
} from '../../src/modules/order-history/search/default-ranges.js';
import { orderSearchInput } from '../../src/modules/order-history/search/contracts.js';
import { orderRange } from '../../src/modules/order-history/contracts.js';

const original = String.raw`
import ast, datetime, json, subprocess, sys, types
body=json.load(sys.stdin)
def text(path):return subprocess.check_output(['git','-C',body['root'],'show','78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:'+path],text=True)
class Frozen(datetime.datetime):
 @classmethod
 def now(cls):return cls.fromisoformat(body['local'])
clock=types.SimpleNamespace(datetime=Frozen,timedelta=datetime.timedelta)
helpers=next(n for n in ast.parse(text('helpers/helpers.py')).body if isinstance(n,ast.ClassDef) and n.name=='Helpers')
helpers.body=[n for n in helpers.body if isinstance(n,ast.FunctionDef) and n.name=='get_days_before_after_datetime']
view=next(n for n in ast.parse(text('order/views.py')).body if isinstance(n,ast.ClassDef) and n.name==('OnlineOrdersView' if body['online'] else 'OrdersView'))
method=next(n for n in view.body if isinstance(n,ast.FunctionDef) and n.name=='get')
namespace={'datetime':clock}
exec(compile(ast.fix_missing_locations(ast.Module(body=[helpers,*method.body[:3 if body['online'] else 4]],type_ignores=[])),'<original-order-date-prefix>','exec'),namespace)
canonical=lambda field:datetime.datetime.strptime(namespace[field],'%m/%d/%Y %I:%M %p').strftime('%Y-%m-%d %H:%M:00')
print(json.dumps({'placedFrom':canonical('StartDateTimeFormat'),'placedTo':canonical('EndDateTimeFormat')}))
`;
const vectors = [
  ['2026-11-18T12:03:45.678Z', 'Asia/Kolkata'],
  ['2026-12-31T18:29:59.999Z', 'Asia/Kolkata'],
  ['2028-02-29T18:29:40Z', 'Asia/Kolkata'],
  ['2026-03-08T06:59:40Z', 'America/New_York'],
  ['2026-11-01T05:59:40Z', 'America/New_York'],
  ['2026-11-01T06:59:40Z', 'America/New_York'],
  ['2026-12-31T23:59:55Z', 'UTC'],
] as const;
describe('source-authoritative rolling order defaults', () => {
  it.each(vectors)(
    'matches literal original helper and active store view prefix at %s in %s',
    (instant, zone) => {
      const now = Date.parse(instant),
        defaults = sourceOrderDefaults(now, zone);
      const local = Temporal.Instant.fromEpochMilliseconds(now)
        .toZonedDateTimeISO(zone)
        .toPlainDateTime()
        .toString();
      for (const online of [false]) {
        const expected: unknown = JSON.parse(
          execFileSync('python3', ['-B', '-c', original], {
            input: JSON.stringify({
              root:
                process.env.ORDER_DEFAULT_SOURCE_ROOT ??
                resolve(process.cwd(), '../../backend-pos-web'),
              local,
              online,
            }),
            encoding: 'utf8',
          }),
        );
        expect(defaults.store).toEqual(expected);
      }
    },
  );
  it('keeps ordinary historical/mixed selections on the original complete whole-window contract', () => {
    const now = Date.parse('2026-11-18T12:00:00Z'),
      defaults = sourceOrderDefaults(now, 'Asia/Kolkata');
    const input = orderSearchInput.parse({
      ...defaults.store,
      from: '2026-11-13',
      to: '2026-11-18',
    });
    const plan = sourceSearchReadPlan(input, 'Asia/Kolkata', now);
    expect(plan.selected).toEqual(
      orderRange({ from: input.from, to: input.to }, 'Asia/Kolkata', now),
    );
    expect(plan.historical).toEqual(plan.selected);
    expect(plan.current).toBeUndefined();
  });
  it('preserves the midnight endpoint with a future PRIMARY fraction and no future warehouse day', () => {
    const now = Date.parse('2026-12-31T18:29:55Z'),
      defaults = sourceOrderDefaults(now, 'Asia/Kolkata');
    const input = orderSearchInput.parse({
      ...defaults.store,
      from: '2026-12-26',
      to: '2027-01-01',
    });
    const plan = sourceSearchReadPlan(input, 'Asia/Kolkata', now);
    expect(input.placedTo).toBe('2027-01-01 00:00:00');
    expect(plan.historical?.to).toBe('2026-12-31');
    expect(plan.current).toMatchObject({
      reader: 'primary',
      start: '2027-01-01 00:00:00',
      end: '2027-01-01 00:00:00.000001',
    });
    for (const orderType of ['ST', 'HL', 'HE', 'N'] as const)
      expect(
        sourceSearchReadPlan(
          orderSearchInput.parse({ ...input, orderType, storeIds: ['1'] }),
          'Asia/Kolkata',
          now,
        ),
      ).toEqual(plan);
    // A frozen original view remains exactly bounded after midnight; it is not regenerated.
    const later = sourceSearchReadPlan(input, 'Asia/Kolkata', now + 120000);
    expect(later.selected.to).toBe('2027-01-01');
    expect(input.placedTo).toBe(defaults.store.placedTo);
  });
  it('rejects tampered future dates/times and preserves invalid/span/report validation', () => {
    const now = Date.parse('2026-12-31T18:29:55Z'),
      base = {
        ...sourceOrderDefaults(now, 'Asia/Kolkata').store,
        from: '2026-12-26',
        to: '2027-01-01',
      };
    for (const change of [
      { placedTo: '2027-01-01 00:01:00' },
      { placedTo: '2026-12-31 23:59:00' },
      { intent: 'report' },
      { to: '2027-01-02' },
      { from: '2027-01-01' },
      { from: '2026-10-01' },
    ])
      expect(() =>
        sourceSearchReadPlan(orderSearchInput.parse({ ...base, ...change }), 'Asia/Kolkata', now),
      ).toThrow();
    expect(() =>
      sourceSearchReadPlan(
        orderSearchInput.parse({ from: '2026-12-31', to: '2026-12-26' }),
        'Asia/Kolkata',
        now,
      ),
    ).toThrow();
    expect(() => sourceOrderDefaults(now, 'Invalid/Zone')).toThrow();
    expect(() => sourceOrderDefaults(NaN, 'UTC')).toThrow();
  });
});
