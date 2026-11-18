import { describe, expect, it } from 'vitest';
import {
  exportMetadataColumns,
  exportMetadataCsv,
  exportMetadataValue,
  type ExportMetadata,
} from '../../src/pages/operational-reports/export-metadata';
const row: ExportMetadata = {
  id: '42',
  origin: 'legacy',
  kind: 'sales',
  reportName: 'Fixture export',
  from: null,
  to: null,
  status: 'COMPLETED',
  message: 'Report file is ready.',
  requestedBy: '10',
  requestedAt: null,
  completedAt: null,
  format: 'CSV',
  byteCount: 0,
  rowCount: 0,
  canDownload: false,
};
describe('loaded-page export metadata controls', () => {
  it('preserves provided source periods including null/empty and actual zero size/row values', () => {
    expect(exportMetadataValue({ ...row, period: null }, 'period')).toBeNull();
    expect(exportMetadataValue({ ...row, period: '' }, 'period')).toBe('');
    expect(exportMetadataValue({ ...row, period: '11/01/2026 - 11/02/2026' }, 'period')).toBe(
      '11/01/2026 - 11/02/2026',
    );
    expect(exportMetadataValue(row, 'rowCount')).toBe(0);
    expect(exportMetadataValue(row, 'byteCount')).toBe('0.0 KB');
    expect(
      exportMetadataValue({ ...row, origin: 'current', kind: 'administration-list' }, 'period'),
    ).toBe('Current collection');
  });
  it('exports only visible loaded-page data in source order and never includes File actions/hidden fields', () => {
    const csv = exportMetadataCsv(
      [{ ...row, period: '', reportName: '\u200b=SUM(1,2)', requestedByName: 'not selected' }],
      ['period', 'reportName'],
    );
    expect(csv).toBe('\uFEFF"Report","Period"\r\n"\'\u200b=SUM(1,2)",""');
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
