import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  rawLegacyExportProjection,
  rawLegacyExportValidationQuery,
} from '../../src/modules/operational-reports/raw-legacy-export.js';
describe('legacy export period projection deployment seam', () => {
  it('selects the exact observed STRING source period without raw source message or file location', () => {
    const metadata = JSON.parse(readFileSync('evidence/bigquery-schema.json', 'utf8')) as {
      tables: Record<string, { schema?: { fields: { name: string; type: string }[] } }>;
    };
    expect(
      metadata.tables.tss_report_exports?.schema?.fields.find(
        (field) => field.name === 'time_period',
      )?.type,
    ).toBe('STRING');
    const query = rawLegacyExportProjection('fixture_source');
    expect(query).toContain('\n    time_period,');
    expect(query).not.toContain('JSON_VALUE');
    expect(query).not.toMatch(/\bmessage\b|\bexport_file_url\b/);
    expect(rawLegacyExportValidationQuery()).toContain(
      'period_start,period_end,time_period,status',
    );
    expect(() => rawLegacyExportProjection('fixture_source; DROP TABLE source')).toThrow();
  });
  it('keeps the committed proposal exactly generated and all3 literal cases source-shaped', () => {
    expect(
      readFileSync('parity/bigquery-deployment/legacy-report-export-projection.sql', 'utf8'),
    ).toBe(
      '-- Reviewed nonfinancial SELECT projection only. No reader activation or publication attestation.\n-- Source: tssgcp2025.tss_mysql_raw_layer.tss_report_exports\n' +
        rawLegacyExportProjection() +
        ';\n',
    );
    const tool = readFileSync('tools/operational-reports/validate-bigquery-raw.ts', 'utf8');
    expect(tool).toContain('CAST(NULL AS STRING) AS time_period');
    expect(tool).toContain("UNION ALL SELECT 2,'Fixture title','fixture-kind','',0");
    expect(tool).toContain("UNION ALL SELECT 3,'','','2026-11-01 - 2026-11-02',0");
    expect(tool).toContain('SELECT id,report_name,time_period,status');
  });
});
