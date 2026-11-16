import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  feedLineSchema,
  reconciliationPage,
  reconciliationRecords,
  type FeedLine,
} from '../../src/modules/finance/feed-domain.js';
const line = (change: Partial<FeedLine> = {}): FeedLine => ({
  id: '1001',
  transaction_date: '2026-11-16',
  LocationCode: 'FIXTURE',
  PaymentMode: 'POC(Cash)',
  PayAmount: 100.1,
  PaymentStatus: 'Paid',
  OrderAmount: 110,
  order_ref_no: 'FIXTURE-1001',
  counter_name: 'Fixture counter',
  TaxRate: 5,
  LineItemSubTotalWoTax: 99.99,
  PayAmountRefunded: 0,
  PayAmountRefundedMode: null,
  CASH: '100.10',
  PaytmCardUpi: null,
  PinelabCardUpi: '0.00',
  OnlineOther: '0.00',
  DistrictAmount: '0.00',
  TssMoneyUsed: 0,
  CreditPincodeAmount: '0.00',
  VoucherAmountUsed: 0,
  CouponAmountUsed: 0,
  TssPointsUsed: 0,
  PgDisc: 0,
  ...change,
});
describe('Glassbox orders feed source record parity', () => {
  it('matches actual Python sale aggregation, individual returns, refund modes, decimal JSON types, lexical sorting and pagination', () => {
    const cases = [];
    for (let index = 0; index < 20; index++)
      cases.push({
        sales: [
          line({
            id: '20',
            LineItemSubTotalWoTax: 2.675 * index,
            TaxRate: index % 2 ? 5 : 12,
            PayAmountRefunded: index / 10,
            PayAmountRefundedMode: index % 2 ? 'cash' : 'TSS_MONEY',
          }),
          line({ id: '20', PayAmountRefunded: 5.005, PayAmountRefundedMode: 'cash' }),
          line({
            id: '100',
            transaction_date: index % 3 ? '2026-11-16' : null,
            CASH: index % 2 ? '0.00' : '100.10',
          }),
        ],
        returns: [
          line({ id: '20', PayAmountRefunded: 2.675, PayAmountRefundedMode: 'tss_money' }),
          line({ id: '20', PayAmountRefunded: 1.005, PayAmountRefundedMode: 'other' }),
        ],
        page: (index % 4) + 1,
        pageSize: (index % 3) + 1,
      });
    const oracle: unknown = JSON.parse(
      execFileSync('python3', ['tools/finance/feed-oracle.py'], {
        input: JSON.stringify({ cases }),
        encoding: 'utf8',
      }),
    );
    expect(
      cases.map((test) =>
        reconciliationPage(
          reconciliationRecords(test.sales, test.returns),
          test.page,
          test.pageSize,
        ),
      ),
    ).toEqual(oracle);
  });
  it('validates provider DTOs without silently dropping a missing financial column', () => {
    expect(feedLineSchema.safeParse({ id: '1' }).success).toBe(false);
    expect(feedLineSchema.parse(line()).id).toBe('1001');
  });
});
