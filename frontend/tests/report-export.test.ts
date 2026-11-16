import { it, expect } from 'vitest';
import { csvCell } from '../src/pages/reports';
it('retains negative numeric amounts while neutralizing spreadsheet formulas in text', () => {
  expect(csvCell(-12.5)).toBe('"-12.5"');
  expect(csvCell('-12.50')).toBe('"-12.50"');
  expect(csvCell('+12')).toBe('"+12"');
  expect(csvCell('-1+2')).toBe('"\'-1+2"');
  expect(csvCell('=IMPORTXML("https://canary.invalid")')).toBe(
    '"\'=IMPORTXML(""https://canary.invalid"")"',
  );
  expect(csvCell('\t@formula')).toBe('"\'\t@formula"');
  expect(csvCell(null)).toBe('""');
});
