import {
  orderReportLineSchema,
  type OrderReportLine,
} from '../../../src/modules/operational-reports/order-report-domain.js';
export function sourceOrderLine(overrides: Partial<OrderReportLine> = {}) {
  return orderReportLineSchema.parse({
    ...Object.fromEntries(Object.keys(orderReportLineSchema.shape).map((key) => [key, null])),
    id: '9007199254740993',
    order_ref_no: 'fixture-reference',
    transaction_status: 'SALE',
    OrderDate: '2026-11-16 10:00:00',
    transaction_date: '2026-11-16 10:00:00',
    LineItemQty: 2,
    LineItemSubTotal: 118,
    TotalOrderQty: 3,
    TaxRate: 18,
    LineItemPgDisc: 0,
    LineItemStoreDiscPG: 0,
    IndividualDisc: 0,
    IndividualPointsUsed: 0,
    LineItemSubTotalWoTax: 100,
    Pricelist: 'Public Pricelist',
    OrderType: 'Forward',
    ...overrides,
  });
}
