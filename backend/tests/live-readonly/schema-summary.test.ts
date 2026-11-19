import { describe, expect, it } from 'vitest';
import { compareTable, summarizeColumnType } from '../../tools/live-readonly/schema.js';

// W26 (UAT run): a drifted 800-character enum made assertAggregateOnly reject the whole summary,
// so neither the summary line nor the evidence file was written.
const safe = /^[A-Za-z0-9_ .:,()'<>/=+-]*$/;
const longEnum = `enum(${Array.from({ length: 70 }, (_, i) => `'STATUS_${i}'`).join(',')})`;

describe('live-readonly drift types are aggregate-safe', () => {
  it('keeps short types and shortens long ones with length and digest', () => {
    expect(summarizeColumnType('varchar(45)')).toBe('varchar(45)');
    const summary = summarizeColumnType(longEnum);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).toMatch(safe);
    expect(summary).toContain(`(${longEnum.length} chars, sha256 `);
    expect(summarizeColumnType(longEnum + 'x')).not.toBe(summary);
  });
  it('compareTable reports a long enum change with summary-safe types', () => {
    const column = (type: string) => ({ COLUMN_NAME: 'status', COLUMN_TYPE: type });
    const drift = compareTable(
      'has_products',
      { columns: [column(longEnum)], createTable: 'a' } as never,
      [column(longEnum.replace("'STATUS_1'", "'PACKED','STATUS_1'"))],
      'b',
    );
    const changed = drift!.columns[0]!;
    expect(changed.attributes).toContain('COLUMN_TYPE');
    for (const type of [changed.snapshotType!, changed.liveType!]) {
      expect(type.length).toBeLessThanOrEqual(200);
      expect(type).toMatch(safe);
    }
  });
});
