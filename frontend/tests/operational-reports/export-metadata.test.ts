import { describe, expect, it } from 'vitest';
import { exportRowSchema } from '../../src/pages/operational-reports/export-commands';
import {
  exportMetadataColumns,
  exportMetadataCsv,
  exportMetadataValue,
  type ExportMetadata,
} from '../../src/pages/operational-reports/export-metadata';
const row: ExportMetadata = {
  id: '42',
  kind: 'DAY_CLOSE',
  reportName: 'Fixture export',
  note: 'Fixture message',
  period: '2026-11-01 - 2026-11-02',
  status: 'COMPLETED',
  exportStatus: 'Completed',
  message: 'Report file is ready.',
  requestedBy: '10',
  requestedByName: 'fixture.operator',
  requestedAt: null,
  completedAt: null,
  format: 'CSV',
  sizeKb: 0,
  rowCount: 0,
  canDownload: false,
};
describe('loaded-page export log metadata', () => {
  it('validates the legacy list row shape and rejects the removed fields', () => {
    expect(exportRowSchema.parse(row)).toEqual(row);
    expect(exportRowSchema.safeParse({ ...row, id: 'not-numeric' }).success).toBe(false);
    expect(exportRowSchema.safeParse({ ...row, status: 'BUILDING' }).success).toBe(false);
  });
  it('shows legacy size, raw status, period and message values', () => {
    expect(exportMetadataValue(row, 'sizeKb')).toBe('-');
    expect(exportMetadataValue({ ...row, sizeKb: 12 }, 'sizeKb')).toBe('12 KB');
    expect(exportMetadataValue(row, 'status')).toBe('Completed');
    expect(exportMetadataValue({ ...row, exportStatus: null }, 'status')).toBe('COMPLETED');
    expect(exportMetadataValue({ ...row, period: null }, 'period')).toBeNull();
    expect(exportMetadataValue(row, 'note')).toBe('Fixture message');
    expect(exportMetadataValue(row, 'requestedBy')).toBe('fixture.operator');
    expect(exportMetadataValue(row, 'rowCount')).toBe(0);
  });
  it('exports only visible loaded-page data in source order and never includes File actions', () => {
    const csv = exportMetadataCsv(
      [{ ...row, period: '', reportName: '​=SUM(1,2)', note: 'not selected' }],
      ['period', 'reportName'],
    );
    expect(csv).toBe('﻿"Report name","Time period"\r\n"\'​=SUM(1,2)",""');
    expect(csv).not.toContain('File');
    expect(csv).not.toContain('not selected');
  });
  it('bounds page exports and refuses empty/duplicate columns without fetching other pages', () => {
    expect(exportMetadataColumns).toHaveLength(12);
    expect(
      exportMetadataCsv(
        Array.from({ length: 500 }, () => row),
        ['id'],
      ).split('\r\n'),
    ).toHaveLength(501);
    expect(() =>
      exportMetadataCsv(
        Array.from({ length: 501 }, () => row),
        ['id'],
      ),
    ).toThrow();
    expect(() => exportMetadataCsv([row], [])).toThrow();
    expect(() => exportMetadataCsv([row], ['id', 'id'])).toThrow();
  });
});
