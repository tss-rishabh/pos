import { describe, expect, it } from 'vitest';
import { orderReportSql } from '../../src/modules/operational-reports/order-report-sql.js';
import {
  orderReportProjection,
  strictOrderReportSelect,
} from '../../src/modules/operational-reports/order-report-query.js';
describe('compiled combined report source SQL', () => {
  it('retains the source aliases and explicit grouped arbitrary projections for all four branches', () => {
    const manifests = Object.values(orderReportSql)
      .flatMap((source) => [source.sales, source.returns])
      .map((query) => orderReportProjection(query));
    expect(manifests.every((item) => item.fields.length > 60)).toBe(true);
    expect(manifests.map((item) => item.fields.map((field) => field.alias))).toEqual(
      Array.from({ length: 4 }, () => manifests[0]!.fields.map((field) => field.alias)),
    );
    for (const source of Object.values(orderReportSql))
      for (const query of [source.sales, source.returns]) {
        const compiled = strictOrderReportSelect(query);
        expect(compiled.includes('ANY_VALUE(')).toBe(true);
        expect(compiled.includes('AS `LineItemSubTotalWoTax`')).toBe(true);
        expect(compiled.includes('store_pg_disc_addons')).toBe(true);
      }
  });
});
