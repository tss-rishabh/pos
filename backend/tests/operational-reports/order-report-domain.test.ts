import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  preparedOrderRecords,
  orderReportHeaders,
  orderReportCsv,
  type OrderReportLine,
} from '../../src/modules/operational-reports/order-report-domain.js';
import { pythonFloatString } from '../../src/modules/operational-reports/number-format.js';
import { sourceOrderLine as base } from './fixtures/order-report.js';

describe('combined order report financial shaping', () => {
  it('matches actual Python source for all tax branches, sale/return signs, ties and zero formatting', () => {
    const cases: { userType: 1 | 2; rows: OrderReportLine[] }[] = ([0, 5, 18, 28] as const).flatMap(
      (tax) =>
        [0, 10].flatMap((store) =>
          [-5, 0, 4].flatMap((points) =>
            (['SALE', 'RETURN'] as const).map((transaction_status) => ({
              userType: 1 as const,
              rows: [
                {
                  ...base(),
                  transaction_status,
                  TaxRate: tax,
                  LineItemStoreDiscPG: store,
                  IndividualPointsUsed: points,
                  LineItemPgDisc: 2.675,
                  IndividualDisc: 1.005,
                  VariantProductId: '123',
                },
              ],
            })),
          ),
        ),
    );
    cases.push({
      userType: 2,
      rows: [
        {
          ...base(),
          LineItemSubTotalWoTax: -0.001,
          LineItemPgDisc: 0.000001,
          VariantProductId: null,
        },
        { ...base(), IsOfflineOrder: 1, IsShopifyOrder: 1, LineItemSubTotalWoTax: 2.5, TaxRate: 0 },
      ],
    });
    const expected: unknown = JSON.parse(
      execFileSync('python3', ['tools/operational-reports/order-report-oracle.py'], {
        input: JSON.stringify({ cases }),
        encoding: 'utf8',
      }),
    );
    expect(cases.map((value) => preparedOrderRecords(value.rows))).toEqual(expected);
    const headerSource = execFileSync(
      'python3',
      ['tools/operational-reports/order-report-oracle.py'],
      { input: JSON.stringify({ operation: 'headers' }), encoding: 'utf8' },
    );
    expect(orderReportHeaders.map(([field, label]) => [label, field])).toEqual(
      JSON.parse(headerSource) as unknown,
    );
  });
  it('retains Python scientific/.0 formatting and protects full CSV formula cells', () => {
    expect([0, -0, 1, 0.00001, 1e16].map(pythonFloatString)).toEqual([
      '0.0',
      '-0.0',
      '1.0',
      '1e-05',
      '1e+16',
    ]);
    const csv = orderReportCsv(preparedOrderRecords([{ ...base(), Message: '=SUM(A1:A2)' }]));
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain('2026-11-16 10:00:00');
    expect(csv.split('\r\n')[0]?.split(',')).toHaveLength(orderReportHeaders.length);
  });
});
