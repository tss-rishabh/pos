import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import { downloadLoadedPageCsv, loadedPageCsv } from '../../src/pages/operational-reports/page-csv';

describe('loaded-page DataTables CSV', () => {
  const anchor = { href: '', download: '', click: vi.fn() };
  beforeEach(() => {
    setRequestOperator('10');
    anchor.click.mockClear();
    vi.stubGlobal('document', { createElement: () => anchor });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    setRequestOperator(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('writes only the given visible columns and loaded rows with formula escaping', () => {
    expect(
      loadedPageCsv(
        ['Store', 'Amount'],
        [
          ['=HYPERLINK("x")', -5],
          [null, '-5.00'],
        ],
      ),
    ).toBe('﻿"Store","Amount"\r\n"\'=HYPERLINK(""x"")","-5"\r\n"","-5.00"');
  });
  it('downloads without any request and refuses a changed operator or no columns', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    downloadLoadedPageCsv('10', 'report-page-1.csv', ['Store'], [['Fixture']]);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('report-page-1.csv');
    expect(() => downloadLoadedPageCsv('11', 'x.csv', ['Store'], [])).toThrow();
    expect(() => downloadLoadedPageCsv('10', 'x.csv', [], [])).toThrow();
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
