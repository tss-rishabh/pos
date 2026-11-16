import { describe, expect, it } from 'vitest';
import {
  batchHistoryCsv,
  batchPreferences,
  batchSecret,
  defaultBatchPreferences,
} from '../../src/pages/administration/gift-card-batches/api';

describe('gift batch private contracts and source metadata export', () => {
  it('exports current-page visible metadata with CSV quoting and spreadsheet formula guards', () => {
    const row = {
      id: '9007199254740993',
      size: 2,
      message: '=HYPERLINK("private")',
      completed: true,
      blocked: true,
      printed: false,
      createdById: '1',
      createdByName: 'Fixture, Operator',
      createdAt: '2026-11-16 12:00:00',
    };
    expect(batchHistoryCsv([row], ['id', 'message', 'createdByName'])).toBe(
      '"Batch","Message","Created by"\r\n"9007199254740993","\'=HYPERLINK(""private"")","Fixture, Operator"\r\n',
    );
    expect(batchHistoryCsv([row], ['status'])).toContain('Blocked · Ready');
  });
  it('persists only bounded static table preferences and validates private password responses', () => {
    expect(batchPreferences.parse(defaultBatchPreferences).columns).toHaveLength(6);
    expect(
      batchPreferences.safeParse({ ...defaultBatchPreferences, columns: ['id', 'id'] }).success,
    ).toBe(false);
    expect(batchPreferences.safeParse({ ...defaultBatchPreferences, columns: [] }).success).toBe(
      false,
    );
    expect(
      batchSecret.safeParse({ filename: 'gift-cards-7.zip', password: 'x'.repeat(43) }).success,
    ).toBe(true);
    expect(batchSecret.safeParse({ filename: '../private.zip', password: '1234' }).success).toBe(
      false,
    );
  });
});
