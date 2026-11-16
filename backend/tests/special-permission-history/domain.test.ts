import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  activityProjection,
  activitySearchInput,
  readSpecialPermissionHistoryOptions,
} from '../../src/modules/special-permission-history/contracts.js';
import {
  activityReadScope,
  activityRecord,
  sourceActivityDate,
  sourceActivityPageStart,
  sourceActivityPattern,
  sourceActivityPlatforms,
} from '../../src/modules/special-permission-history/domain.js';
import { historicalActivityQuery } from '../../src/modules/special-permission-history/warehouse-sql.js';

const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'isolated-history-domain-fixture-secret'.repeat(2),
});
describe('source SpecialPermission history contracts', () => {
  it('selects the report reader only for the exact current source business day', () => {
    const input = activitySearchInput.parse({ from: '2026-11-16', to: '2026-11-16' });
    expect(
      activityReadScope(config, input, Temporal.Instant.from('2026-11-15T18:29:59Z')).reader,
    ).toBe('bigquery');
    expect(activityReadScope(config, input, Temporal.Instant.from('2026-11-15T18:30:00Z'))).toEqual(
      {
        today: '2026-11-16',
        reader: 'data-reader',
        from: '2026-11-16 00:00:00',
        to: '2026-11-17 00:00:00',
      },
    );
    for (const value of [
      {},
      { from: '2026-11-15', to: '2026-11-16' },
      { from: '2026-11-17', to: '2026-11-17' },
    ])
      expect(
        activityReadScope(
          config,
          activitySearchInput.parse(value),
          Temporal.Instant.from('2026-11-16T12:00:00Z'),
        ).reader,
      ).toBe('bigquery');
  });
  it('preserves source platform splitting, literal search content and ignored ordering while bounding input', () => {
    const value = activitySearchInput.parse({
      platforms: ['', '   ', ' barcode ', 'barcode'],
      search: '  "50%_\\"  ',
      order: { column: 5, direction: 'desc' },
      length: 500,
    });
    expect(sourceActivityPlatforms(value.platforms)).toEqual(['', 'barcode']);
    expect(sourceActivityPlatforms(['\u0085barcode\u001c', '\ufeffbarcode'])).toEqual([
      'barcode',
      '\ufeffbarcode',
    ]);
    expect(value.search).toBe('  "50%_\\"  ');
    expect(value.order).toEqual({ column: 5, direction: 'desc' });
    for (const bad of [
      { from: '2026-11-16' },
      { from: '2026-11-17', to: '2026-11-16' },
      { from: '2026-02-29', to: '2026-02-29' },
      { length: 501 },
      { storeIds: ['1'] },
      { search: 'x'.repeat(256) },
    ])
      expect(activitySearchInput.safeParse(bad).success).toBe(false);
    expect(activitySearchInput.parse({}).length).toBe(10);
  });
  it('escapes percent, underscore and backslash as literal Django icontains characters after quote substitution', () => {
    expect(sourceActivityPattern('"50%_\\"')).toBe("%'50\\%\\_\\\\'%");
    expect(sourceActivityPattern(' Café ')).toBe('% Café %');
  });
  it('returns the first source page for negative, non-aligned and out-of-range starts without rounding counts', () => {
    expect(sourceActivityPageStart(500, 500, 9007199254740993n)).toBe(500);
    expect(sourceActivityPageStart(Number.MAX_SAFE_INTEGER - 1, 2, 9007199254740993n)).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    for (const start of [-10, -1, 1, 21, 1000000])
      expect(sourceActivityPageStart(start, 10, 20n)).toBe(0);
    expect(sourceActivityPageStart(10, 10, 20n)).toBe(10);
    expect(sourceActivityPageStart(0, 10, 0n)).toBe(0);
  });
  it('retains USE_TZ=False wall time and Django JSON millisecond truncation without shifting source dates', () => {
    expect(sourceActivityDate('2026-11-16 23:59:59')).toBe('2026-11-16T23:59:59');
    expect(sourceActivityDate('2026-11-16 01:02:03.123999')).toBe('2026-11-16T01:02:03.123');
    expect(sourceActivityDate('2026-11-16 01:02:03.000001')).toBe('2026-11-16T01:02:03.000');
    expect(sourceActivityDate('2026-11-16 01:02:03.000000')).toBe('2026-11-16T01:02:03');
    expect(sourceActivityDate('0000-00-00 00:00:00')).toBe('0000-00-00 00:00:00');
    expect(
      activityReadScope(
        config,
        activitySearchInput.parse({ from: '9999-12-31', to: '9999-12-31' }),
        Temporal.Instant.from('2026-11-16T12:00:00Z'),
      ).to,
    ).toBeNull();
  });
  it('keeps signed 64-bit IDs, raw source names, missing-user fallback and recipient emptiness distinct', () => {
    const row = activityProjection.parse({
      id: '9223372036854775807',
      actorExists: true,
      firstName: '',
      lastName: '',
      platform: 'barcode',
      comment: null,
      createdAt: '2026-11-16 00:00:00',
      recipient: '  ',
    });
    expect(activityRecord(row)).toMatchObject({
      id: '9223372036854775807',
      addedBy: ' ',
      recipient: '  ',
      comment: null,
    });
    expect(
      activityRecord({
        ...row,
        actorExists: false,
        firstName: null,
        lastName: null,
        recipient: null,
      }),
    ).toMatchObject({ addedBy: 'unknown', recipient: 'NA' });
    expect(
      activityRecord({ ...row, firstName: '  Saved', lastName: 'Actor  ', recipient: '' }),
    ).toMatchObject({ addedBy: '  Saved Actor  ', recipient: 'NA' });
    expect(activityProjection.safeParse({ ...row, id: '9223372036854775808' }).success).toBe(false);
    expect(activityProjection.safeParse({ ...row, id: '0001' }).success).toBe(false);
    expect(
      activityProjection.safeParse({ ...row, actorExists: true, firstName: null }).success,
    ).toBe(false);
  });
  it('accepts only fully qualified deployment resource identifiers and emits bounded, bound historical SQL', () => {
    const options = readSpecialPermissionHistoryOptions({
      BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW: 'sample-project.pos.activity',
      BQ_SPECIAL_PERMISSION_ACTIVITY_MATCH_UDF: 'sample-project.pos.source_match',
    });
    const statement = historicalActivityQuery(
      options.BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW!,
      options.BQ_SPECIAL_PERMISSION_ACTIVITY_MATCH_UDF,
      true,
      true,
    );
    expect(statement).toContain('`sample-project.pos.activity`');
    for (const name of ['fromTime', 'toTime', 'platforms', 'pattern', 'start', 'length'])
      expect(statement).toContain('@' + name);
    for (const label of [
      'platform.in',
      'recipient.icontains',
      'comment.icontains',
      'platform.icontains',
      'created_at.icontains',
    ])
      expect(statement).toContain("'" + label + "'");
    expect(statement).toContain('CAST(id AS BIGNUMERIC) ASC');
    expect(statement).toContain('n.row_number<=p.actual_start+@length');
    expect(statement).not.toMatch(/LOWER\(|NORMALIZE\(|TRIM\(/);
    expect(
      historicalActivityQuery('sample-project.pos.activity', undefined, false, false),
    ).not.toContain('`undefined`');
    for (const resource of [
      'activity',
      'sample-project.pos.activity` UNION SELECT 1',
      'sample-project.pos.activity;',
    ])
      expect(() =>
        readSpecialPermissionHistoryOptions({ BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW: resource }),
      ).toThrow();
  });
});
